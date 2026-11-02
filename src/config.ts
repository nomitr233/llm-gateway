import { z } from "zod";
import { ERROR_CODES, GatewayError } from "./errors.ts";

export interface GatewayConfig {
    host: string;
    port: number;
    logLevel: LogLevel;
    /** 同一个上游上最多再重试几次（0 = 只试一次） */
    retriesPerUpstream: number;
    /** 配置与密钥都在库里，网关没有数据库就起不来 */
    databaseUrl: string;
    /** 加密 provider key 的主密钥 */
    gatewaySecret: string;
    dbPoolMax: number;
    /** 管理面板密码；为 null 时面板关闭 */
    adminPassword: string | null;
}

const LogLevelSchema = z.enum(["fatal", "error", "warn", "info", "debug", "trace"]);
export type LogLevel = z.infer<typeof LogLevelSchema>;

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4100;

const stringFromEnv = (fallback: string) =>
    z.preprocess((value) => (value === undefined || value === "" ? undefined : value), z.string().min(1).default(fallback));

const optionalStringFromEnv = z.preprocess(
    (value) => (value === undefined || (typeof value === "string" && value.trim() === "") ? undefined : value),
    z.string().min(1).optional(),
);

const intFromEnv = (fallback: number, min: number, max: number) =>
    z.preprocess(
        (value) => (value === undefined || value === "" ? undefined : value),
        z.coerce.number().int().min(min).max(max).default(fallback),
    );

const logLevelFromEnv = z.preprocess(
    (value) => (value === undefined || value === "" ? undefined : value),
    LogLevelSchema.default("info"),
);

const envSchema = z.object({
    HOST: stringFromEnv(DEFAULT_HOST),
    PORT: intFromEnv(DEFAULT_PORT, 1, 65535),
    LOG_LEVEL: logLevelFromEnv,
    RETRIES_PER_UPSTREAM: intFromEnv(1, 0, 10),
    DB_POOL_MAX: intFromEnv(10, 1, 100),
    DATABASE_URL: optionalStringFromEnv,
    GATEWAY_SECRET: optionalStringFromEnv,
    ADMIN_PASSWORD: optionalStringFromEnv,
});

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
    const parsed = envSchema.safeParse(env);
    if (!parsed.success) {
        const details = parsed.error.issues
            .map((issue) => `${issue.path.join(".") || "env"}: ${issue.message}`)
            .join("; ");
        throw new GatewayError(ERROR_CODES.CONFIG_ERROR, `环境变量校验失败 → ${details}`);
    }

    const values = parsed.data;
    if (values.DATABASE_URL === undefined) {
        throw new GatewayError(ERROR_CODES.CONFIG_ERROR, "缺少 DATABASE_URL：provider、模型和服务 key 都存在数据库里");
    }
    if (values.GATEWAY_SECRET === undefined) {
        throw new GatewayError(
            ERROR_CODES.CONFIG_ERROR,
            "缺少 GATEWAY_SECRET：没有它无法解密 provider key，拒绝启动",
        );
    }

    if (values.ADMIN_PASSWORD !== undefined && values.ADMIN_PASSWORD.length < 8) {
        throw new GatewayError(ERROR_CODES.CONFIG_ERROR, "ADMIN_PASSWORD 至少 8 位；不想开面板就不要设置它");
    }

    return {
        host: values.HOST,
        port: values.PORT,
        logLevel: values.LOG_LEVEL,
        retriesPerUpstream: values.RETRIES_PER_UPSTREAM,
        databaseUrl: normalizeDatabaseUrl(values.DATABASE_URL),
        gatewaySecret: values.GATEWAY_SECRET,
        dbPoolMax: values.DB_POOL_MAX,
        adminPassword: values.ADMIN_PASSWORD ?? null,
    };
}

/**
 * SQLAlchemy 风格的连接串（postgresql+asyncpg://）node 的 pg 驱动不认，
 * 这里把 +driver 这一段去掉；密码里的 %40 之类百分号编码要保留，pg 会自己解码。
 */
function normalizeDatabaseUrl(raw: string): string {
    return raw.replace(/^postgres(?:ql)?\+[a-z0-9_]+:\/\//i, "postgresql://");
}
