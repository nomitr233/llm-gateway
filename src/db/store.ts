import { Client, Pool, type Notification, type PoolClient, type QueryResultRow } from "pg";
import { decryptSecret } from "../crypto.ts";
import { ERROR_CODES, GatewayError } from "../errors.ts";
import { logger } from "../logger.ts";
import type { Upstream } from "../upstream/provider.ts";
import { OpenAIUpstream } from "../upstream/openai.ts";
import { OpenAIImagesUpstream } from "../upstream/openai-images.ts";
import { OpenAISpeechUpstream } from "../upstream/openai-speech.ts";
import { applySchema } from "./schema.ts";

/** 配置变更广播通道：任何进程写完配置都 NOTIFY，所有网关实例重载快照 */
const CONFIG_CHANNEL = "gateway_config";

export const CATEGORIES = ["text", "image", "video", "jev", "tts", "asr"] as const;
export type Category = (typeof CATEGORIES)[number];

export function isCategory(value: string): value is Category {
    return (CATEGORIES as readonly string[]).includes(value);
}

export interface ServiceRow {
    id: number;
    name: string;
    enabled: boolean;
    keyPreview: string;
}

export interface ModelEntry {
    publicName: string;
    category: Category;
    upstreamModel: string;
    provider: string;
    upstream: Upstream;
}

/**
 * 运行期只读的不可变快照：请求路径上零配置 IO，也不碰数据库。
 * 面板/CLI 改完配置后整体替换，不做增量修改。
 */
export interface Snapshot {
    version: number;
    services: ReadonlyMap<number, ServiceRow>;
    /** key = SHA-256(服务 key)，查询直接命中，不需要遍历比较 */
    servicesByKeyHash: ReadonlyMap<string, ServiceRow>;
    modelsByPublicName: ReadonlyMap<string, ModelEntry>;
    defaultByCategory: ReadonlyMap<Category, ModelEntry>;
}

interface ProviderRow {
    id: number;
    name: string;
    kind: string;
    base_url: string;
    api_key_ciphertext: string;
    timeout_ms: number;
}

interface ModelRow {
    provider_id: number;
    public_name: string;
    upstream_model: string;
    category: string;
    is_default: boolean;
}

interface ServiceDbRow {
    id: number;
    name: string;
    key_hash: string;
    key_preview: string;
    enabled: boolean;
}

export interface StoreOptions {
    databaseUrl: string;
    masterSecret: string;
    poolMax: number;
    /** 启动时自动补齐表结构；幂等，默认开 */
    migrate?: boolean;
}

export class Store {
    private readonly pool: Pool;
    private readonly masterSecret: string;
    private readonly databaseUrl: string;
    private snapshot: Snapshot;
    private version = 0;
    private listener: Client | null = null;

    private constructor(pool: Pool, masterSecret: string, databaseUrl: string, snapshot: Snapshot) {
        this.pool = pool;
        this.masterSecret = masterSecret;
        this.databaseUrl = databaseUrl;
        this.snapshot = snapshot;
        this.version = snapshot.version;
    }

    static async open(options: StoreOptions): Promise<Store> {
        const pool = new Pool({
            connectionString: options.databaseUrl,
            max: options.poolMax,
            connectionTimeoutMillis: 10_000,
            idleTimeoutMillis: 30_000,
        });
        // 空闲连接被服务端掐断时不能让它变成未捕获异常，否则进程直接挂
        pool.on("error", (error: Error) => {
            logger.error({ err: error.message }, "数据库连接池错误");
        });

        try {
            if (options.migrate !== false) {
                const client = await pool.connect();
                try {
                    await applySchema(client);
                } finally {
                    client.release();
                }
            }
            const snapshot = await loadSnapshot(pool, options.masterSecret, 1);
            const store = new Store(pool, options.masterSecret, options.databaseUrl, snapshot);
            await store.startListening();
            return store;
        } catch (error) {
            await pool.end().catch(() => {});
            throw error;
        }
    }

    /**
     * CLI / 面板都是别的进程，改完库之后必须让跑着的网关知道。
     * 用 PG 的 LISTEN/NOTIFY，比轮询省事也不会漏。
     */
    private async startListening(): Promise<void> {
        const client = new Client({ connectionString: this.databaseUrl });
        client.on("error", (error: Error) => {
            logger.error({ err: error.message }, "配置监听连接出错，后续变更需要重启才能生效");
        });
        client.on("notification", (message: Notification) => {
            if (message.channel !== CONFIG_CHANNEL) return;
            void this.reload("notify");
        });
        await client.connect();
        await client.query(`listen ${CONFIG_CHANNEL}`);
        this.listener = client;
    }

    private async reload(reason: string): Promise<void> {
        try {
            const snapshot = await loadSnapshot(this.pool, this.masterSecret, this.version + 1);
            this.snapshot = snapshot;
            this.version = snapshot.version;
            logger.info(
                {
                    reason,
                    snapshotVersion: snapshot.version,
                    models: snapshot.modelsByPublicName.size,
                    services: snapshot.services.size,
                },
                "配置快照已刷新",
            );
        } catch (error) {
            // 新配置有问题时保留旧快照，让网关继续以旧配置服务
            logger.error({ reason, err: error instanceof Error ? error.message : String(error) }, "配置刷新失败，继续使用旧快照");
        }
    }

    getSnapshot(): Snapshot {
        return this.snapshot;
    }

    /** 只读查询，给 CLI / 面板用；请求路径不应该走这里 */
    async query<T extends QueryResultRow>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
        const result = await this.pool.query<T>(sql, params as unknown[]);
        return result.rows;
    }

    /**
     * 写穿：事务提交成功后才重载快照并整体替换，失败则回滚、快照保持旧值。
     * 单进程内并发调用是安全的——每次重载都读已提交状态，最坏是多读一次。
     */
    async mutate<T>(action: (client: PoolClient) => Promise<T>): Promise<T> {
        const client = await this.pool.connect();
        try {
            await client.query("begin");
            const result = await action(client);
            await client.query("commit");
            // 广播给其它网关实例；本实例也立即重载一次，不依赖通知的异步到达
            await client.query("select pg_notify($1, '')", [CONFIG_CHANNEL]);
            await this.reload("mutate");
            return result;
        } catch (error) {
            await client.query("rollback").catch(() => {});
            throw error;
        } finally {
            client.release();
        }
    }

    async close(): Promise<void> {
        const listener = this.listener;
        this.listener = null;
        if (listener !== null) {
            await listener.end().catch(() => {});
        }
        await this.pool.end();
    }

    async pingDatabase(): Promise<{ db: string; user: string }> {
        const result = await this.pool.query<{ db: string; db_user: string }>(
            "select current_database() as db, current_user as db_user",
        );
        const row = result.rows[0];
        if (row === undefined) throw new Error("数据库探活没有返回行");
        return { db: row.db, user: row.db_user };
    }
}

async function loadSnapshot(pool: Pool, masterSecret: string, version: number): Promise<Snapshot> {
    const providerRows = await pool.query<ProviderRow>(
        "select id, name, kind, base_url, api_key_ciphertext, timeout_ms from providers where enabled",
    );

    const upstreams = new Map<number, Map<Category, Upstream>>();
    for (const row of providerRows.rows) {
        if (row.kind !== "openai") {
            throw new GatewayError(ERROR_CODES.CONFIG_ERROR, `provider "${row.name}" 的协议 kind="${row.kind}" 暂不支持`);
        }
        let apiKey: string;
        try {
            apiKey = decryptSecret(row.api_key_ciphertext, masterSecret);
        } catch (error) {
            // 只可能是主密钥换了，或者密文被改过；此时任何请求都发不出去，必须显式暴露
            throw new GatewayError(
                ERROR_CODES.CONFIG_ERROR,
                `provider "${row.name}" 的 key 解密失败：GATEWAY_SECRET 与落库时不一致？`,
                { cause: error },
            );
        }
        const options = {
            name: row.name,
            baseUrl: row.base_url,
            apiKey,
            timeoutMs: row.timeout_ms,
        };
        // 同一个 provider 的不同类别走不同协议路径；没适配器的类别就是没登记
        upstreams.set(
            row.id,
            new Map<Category, Upstream>([
                ["text", new OpenAIUpstream(options)],
                ["image", new OpenAIImagesUpstream(options)],
                ["tts", new OpenAISpeechUpstream(options)],
            ]),
        );
    }

    const modelRows = await pool.query<ModelRow>(
        `select m.provider_id, m.public_name, m.upstream_model, m.category, m.is_default
           from models m
           join providers p on p.id = m.provider_id and p.enabled
          where m.enabled`,
    );

    const modelsByPublicName = new Map<string, ModelEntry>();
    const defaultByCategory = new Map<Category, ModelEntry>();
    for (const row of modelRows.rows) {
        if (!isCategory(row.category)) {
            throw new GatewayError(ERROR_CODES.CONFIG_ERROR, `模型 "${row.public_name}" 的类别 "${row.category}" 非法`);
        }
        const upstream = upstreams.get(row.provider_id)?.get(row.category);
        if (upstream === undefined) {
            logger.warn(
                { model: row.public_name, category: row.category },
                "该类别还没有对应的上游协议实现，模型暂时不可调用",
            );
            continue;
        }
        const entry: ModelEntry = {
            publicName: row.public_name,
            category: row.category,
            upstreamModel: row.upstream_model,
            provider: upstream.name,
            upstream,
        };
        modelsByPublicName.set(entry.publicName, entry);
        if (row.is_default) defaultByCategory.set(entry.category, entry);
    }

    const serviceRows = await pool.query<ServiceDbRow>("select id, name, key_hash, key_preview, enabled from services");

    const services = new Map<number, ServiceRow>();
    const servicesByKeyHash = new Map<string, ServiceRow>();
    for (const row of serviceRows.rows) {
        const service: ServiceRow = {
            id: row.id,
            name: row.name,
            enabled: row.enabled,
            keyPreview: row.key_preview,
        };
        services.set(service.id, service);
        servicesByKeyHash.set(row.key_hash, service);
    }

    return { version, services, servicesByKeyHash, modelsByPublicName, defaultByCategory };
}
