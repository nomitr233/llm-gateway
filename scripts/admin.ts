// 面板做出来之前的管理入口。所有写操作都走 Store.mutate（事务 + 写穿替换快照），
// 所以正在运行的网关会在下一次请求时用上新配置，不用重启。
import "../src/env.ts";
import { loadConfig } from "../src/config.ts";
import { encryptSecret, generateServiceKey, hashServiceKey, previewServiceKey } from "../src/crypto.ts";
import { SCHEMA_VERSION } from "../src/db/schema.ts";
import { CATEGORIES, isCategory, Store } from "../src/db/store.ts";

const USAGE = `
用法：node scripts/admin.ts <命令> [参数]

  migrate                                   建表 / 升级表结构（幂等）
  provider add --name <名字> --base-url <地址> --api-key <上游 key> [--timeout 120000]
  provider list
  provider disable --name <名字>
  provider enable --name <名字>
  model add --public <下游看到的模型名> --provider <provider 名> --upstream <真实模型名>
            --category <${CATEGORIES.join("|")}> [--default]
  model list
  model default --public <模型名>
  model disable --public <模型名>
  model enable --public <模型名>
  service add --name <服务名>                生成一把服务 key（明文只打印一次）
  service list                               只显示前后缀，不显示完整 key
  service disable --name <服务名>
  service enable --name <服务名>
`;

function parseFlags(args: readonly string[]): Record<string, string> {
    const flags: Record<string, string> = {};
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if (arg === undefined || !arg.startsWith("--")) continue;
        const name = arg.slice(2);
        const value = args[index + 1];
        if (value === undefined || value.startsWith("--")) {
            flags[name] = "true";
            continue;
        }
        flags[name] = value;
        index += 1;
    }
    return flags;
}

function requireFlag(flags: Record<string, string>, name: string): string {
    const value = flags[name];
    if (value === undefined || value === "" || value === "true") {
        throw new Error(`缺少参数 --${name}\n${USAGE}`);
    }
    return value;
}

async function main(): Promise<void> {
    const argv = process.argv.slice(2);
    const command = argv[0];
    const subcommand = argv[1];
    const flags = parseFlags(argv.slice(2));

    if (command === undefined || command === "--help" || command === "help") {
        console.log(USAGE.trim());
        return;
    }

    const config = loadConfig();
    const store = await Store.open({
        databaseUrl: config.databaseUrl,
        masterSecret: config.gatewaySecret,
        poolMax: config.dbPoolMax,
    });

    try {
        switch (command) {
            case "migrate": {
                const rows = await store.query<{ version: number }>("select version from schema_version order by version desc limit 1");
                console.log(`表结构就绪，当前 schema_version = ${rows[0]?.version ?? "-"}（代码期望 ${SCHEMA_VERSION}）`);
                return;
            }
            case "provider":
                await handleProvider(store, subcommand, flags, config.gatewaySecret);
                return;
            case "model":
                await handleModel(store, subcommand, flags);
                return;
            case "service":
                await handleService(store, subcommand, flags);
                return;
            default:
                console.log(USAGE.trim());
                process.exitCode = 1;
        }
    } finally {
        await store.close();
    }
}

async function handleProvider(
    store: Store,
    subcommand: string | undefined,
    flags: Record<string, string>,
    masterSecret: string,
): Promise<void> {
    if (subcommand === "add") {
        const name = requireFlag(flags, "name");
        const baseUrl = requireFlag(flags, "base-url").replace(/\/+$/, "");
        const apiKey = requireFlag(flags, "api-key");
        const timeoutMs = Number(flags.timeout ?? 120_000);
        if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new Error("--timeout 必须是正整数");

        await store.mutate(async (client) => {
            await client.query(
                `insert into providers (name, base_url, api_key_ciphertext, timeout_ms)
                 values ($1, $2, $3, $4)
                 on conflict (name) do update
                    set base_url = excluded.base_url,
                        api_key_ciphertext = excluded.api_key_ciphertext,
                        timeout_ms = excluded.timeout_ms,
                        enabled = true`,
                [name, baseUrl, encryptSecret(apiKey, masterSecret), timeoutMs],
            );
        });
        console.log(`provider ${name} 已写入（key 已用 GATEWAY_SECRET 加密）`);
        return;
    }

    if (subcommand === "list") {
        const rows = await store.query<{ name: string; base_url: string; timeout_ms: number; enabled: boolean }>(
            "select name, base_url, timeout_ms, enabled from providers order by name",
        );
        if (rows.length === 0) console.log("（还没有 provider）");
        for (const row of rows) {
            console.log(`${row.enabled ? "✔" : "✘"} ${row.name}  ${row.base_url}  timeout=${row.timeout_ms}ms`);
        }
        return;
    }

    if (subcommand === "disable" || subcommand === "enable") {
        const name = requireFlag(flags, "name");
        const enabled = subcommand === "enable";
        await store.mutate((client) => client.query("update providers set enabled = $2 where name = $1", [name, enabled]));
        console.log(`provider ${name} 已${enabled ? "启用" : "禁用"}`);
        return;
    }

    throw new Error(`未知的 provider 子命令：${subcommand ?? "(空)"}\n${USAGE}`);
}

async function handleModel(store: Store, subcommand: string | undefined, flags: Record<string, string>): Promise<void> {
    if (subcommand === "add") {
        const publicName = requireFlag(flags, "public");
        const providerName = requireFlag(flags, "provider");
        const upstreamModel = requireFlag(flags, "upstream");
        const category = requireFlag(flags, "category");
        if (!isCategory(category)) throw new Error(`--category 只能是 ${CATEGORIES.join("|")}`);
        const makeDefault = flags.default === "true";

        await store.mutate(async (client) => {
            const provider = await client.query<{ id: number }>("select id from providers where name = $1", [providerName]);
            const providerId = provider.rows[0]?.id;
            if (providerId === undefined) throw new Error(`provider "${providerName}" 不存在，先 provider add`);

            if (makeDefault) {
                await client.query("update models set is_default = false where category = $1 and is_default", [category]);
            }
            await client.query(
                `insert into models (provider_id, public_name, upstream_model, category, is_default)
                 values ($1, $2, $3, $4, $5)
                 on conflict (public_name) do update
                    set provider_id = excluded.provider_id,
                        upstream_model = excluded.upstream_model,
                        category = excluded.category,
                        is_default = excluded.is_default,
                        enabled = true`,
                [providerId, publicName, upstreamModel, category, makeDefault],
            );
        });
        console.log(`模型 ${publicName} → ${providerName}/${upstreamModel}（${category}${makeDefault ? "，默认" : ""}）已写入`);
        return;
    }

    if (subcommand === "list") {
        const rows = await store.query<{
            public_name: string;
            category: string;
            upstream_model: string;
            provider: string;
            is_default: boolean;
            enabled: boolean;
        }>(
            `select m.public_name, m.category, m.upstream_model, p.name as provider, m.is_default, m.enabled
               from models m join providers p on p.id = m.provider_id
              order by m.category, m.public_name`,
        );
        if (rows.length === 0) console.log("（还没有模型）");
        for (const row of rows) {
            const mark = `${row.enabled ? "✔" : "✘"}${row.is_default ? "★" : " "}`;
            console.log(`${mark} ${row.public_name}  [${row.category}] → ${row.provider}/${row.upstream_model}`);
        }
        return;
    }

    if (subcommand === "default") {
        const publicName = requireFlag(flags, "public");
        await store.mutate(async (client) => {
            const found = await client.query<{ category: string }>("select category from models where public_name = $1", [
                publicName,
            ]);
            const category = found.rows[0]?.category;
            if (category === undefined) throw new Error(`模型 "${publicName}" 不存在`);
            await client.query("update models set is_default = false where category = $1 and is_default", [category]);
            await client.query("update models set is_default = true where public_name = $1", [publicName]);
        });
        console.log(`${publicName} 已设为该类别的默认模型`);
        return;
    }

    if (subcommand === "disable" || subcommand === "enable") {
        const publicName = requireFlag(flags, "public");
        const enabled = subcommand === "enable";
        await store.mutate((client) =>
            client.query("update models set enabled = $2 where public_name = $1", [publicName, enabled]),
        );
        console.log(`模型 ${publicName} 已${enabled ? "启用" : "禁用"}`);
        return;
    }

    throw new Error(`未知的 model 子命令：${subcommand ?? "(空)"}\n${USAGE}`);
}

async function handleService(store: Store, subcommand: string | undefined, flags: Record<string, string>): Promise<void> {
    if (subcommand === "add") {
        const name = requireFlag(flags, "name");
        const key = generateServiceKey();

        await store.mutate(async (client) => {
            await client.query(
                `insert into services (name, key_hash, key_preview)
                 values ($1, $2, $3)
                 on conflict (name) do update
                    set key_hash = excluded.key_hash,
                        key_preview = excluded.key_preview,
                        enabled = true`,
                [name, hashServiceKey(key), previewServiceKey(key)],
            );
        });

        console.log(`服务 ${name} 的 key（只显示这一次，请立刻保存）：`);
        console.log(`  ${key}`);
        return;
    }

    if (subcommand === "list") {
        const rows = await store.query<{ name: string; key_preview: string; enabled: boolean }>(
            "select name, key_preview, enabled from services order by name",
        );
        if (rows.length === 0) console.log("（还没有服务）");
        for (const row of rows) {
            console.log(`${row.enabled ? "✔" : "✘"} ${row.name}  ${row.key_preview}`);
        }
        return;
    }

    if (subcommand === "disable" || subcommand === "enable") {
        const name = requireFlag(flags, "name");
        const enabled = subcommand === "enable";
        await store.mutate((client) => client.query("update services set enabled = $2 where name = $1", [name, enabled]));
        console.log(`服务 ${name} 已${enabled ? "启用" : "禁用"}`);
        return;
    }

    throw new Error(`未知的 service 子命令：${subcommand ?? "(空)"}\n${USAGE}`);
}

try {
    await main();
} catch (error) {
    console.error(`失败：${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
}
