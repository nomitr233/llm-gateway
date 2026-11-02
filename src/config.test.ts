import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.ts";

const baseEnv = {
    DATABASE_URL: "postgresql://u:p@127.0.0.1:5432/db",
    GATEWAY_SECRET: "master-secret",
};

describe("启动配置", () => {
    it("默认监听 127.0.0.1:4100", () => {
        const config = loadConfig({ ...baseEnv });
        expect(config.host).toBe("127.0.0.1");
        expect(config.port).toBe(4100);
        expect(config.logLevel).toBe("info");
        expect(config.retriesPerUpstream).toBe(1);
    });

    it("PORT 和 LOG_LEVEL 支持覆盖", () => {
        const config = loadConfig({ ...baseEnv, PORT: "8080", LOG_LEVEL: "debug" });
        expect(config.port).toBe(8080);
        expect(config.logLevel).toBe("debug");
    });

    it("PORT 非法时报错信息里带出变量名", () => {
        expect(() => loadConfig({ ...baseEnv, PORT: "abc" })).toThrow(/PORT/);
        expect(() => loadConfig({ ...baseEnv, PORT: "70000" })).toThrow(/PORT/);
    });

    it("没有数据库连接串时拒绝启动", () => {
        expect(() => loadConfig({ GATEWAY_SECRET: "master-secret" })).toThrow(/DATABASE_URL/);
    });

    it("没有 GATEWAY_SECRET 时拒绝启动", () => {
        expect(() => loadConfig({ DATABASE_URL: baseEnv.DATABASE_URL })).toThrow(/GATEWAY_SECRET/);
    });

    it("SQLAlchemy 风格的连接串会被纠正成 pg 能用的形式", () => {
        const config = loadConfig({
            ...baseEnv,
            DATABASE_URL: "postgresql+asyncpg://u:p%40ss@h:5432/db",
        });
        expect(config.databaseUrl).toBe("postgresql://u:p%40ss@h:5432/db");
    });

    it("密码里的百分号编码保持原样，交给 pg 解码", () => {
        const config = loadConfig({ ...baseEnv, DATABASE_URL: "postgresql://u:p%40ss@h:5432/db" });
        expect(config.databaseUrl).toContain("%40");
    });

    it("面板白名单默认只允许回环", () => {
        const config = loadConfig({ ...baseEnv });
        expect(config.adminAllowedIps).toEqual(["127.0.0.1", "::1"]);
        expect(config.adminPassword).toBeNull();
    });

    it("面板白名单支持逗号分隔和 CIDR（容器部署要用）", () => {
        const config = loadConfig({ ...baseEnv, ADMIN_ALLOWED_IPS: "127.0.0.1, 172.18.0.1 ,172.16.0.0/12" });
        expect(config.adminAllowedIps).toEqual(["127.0.0.1", "172.18.0.1", "172.16.0.0/12"]);
    });

    it("面板密码太短时拒绝启动", () => {
        expect(() => loadConfig({ ...baseEnv, ADMIN_PASSWORD: "short" })).toThrow(/ADMIN_PASSWORD/);
    });
});
