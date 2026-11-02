import "./env.ts";
import { loadConfig, type GatewayConfig } from "./config.ts";
import { Store } from "./db/store.ts";
import { asGatewayError } from "./errors.ts";
import { logger } from "./logger.ts";
import { startServer } from "./server/http.ts";

async function bootstrap(): Promise<void> {
    const config: GatewayConfig = loadConfig();

    const store = await Store.open({
        databaseUrl: config.databaseUrl,
        masterSecret: config.gatewaySecret,
        poolMax: config.dbPoolMax,
    });

    const snapshot = store.getSnapshot();
    logger.info(
        {
            snapshotVersion: snapshot.version,
            models: snapshot.modelsByPublicName.size,
            services: snapshot.services.size,
            defaults: [...snapshot.defaultByCategory.keys()],
        },
        "配置快照已加载",
    );

    const server = startServer(config, store);

    for (const signal of ["SIGINT", "SIGTERM"] as const) {
        process.on(signal, () => {
            logger.info({ signal }, "正在关闭");
            server.close(() => {
                void store.close().finally(() => process.exit(0));
            });
            // 兜底：10s 还没关完（比如还挂着流式连接）就直接退出
            setTimeout(() => process.exit(1), 10_000).unref();
        });
    }
}

try {
    await bootstrap();
} catch (error) {
    const gatewayError = asGatewayError(error);
    logger.error({ code: gatewayError.code, status: gatewayError.status }, `启动失败：${gatewayError.message}`);
    if (process.env.DEBUG) logger.error(gatewayError);
    process.exit(1);
}
