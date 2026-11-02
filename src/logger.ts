import pino from "pino";

/** 模块加载期就固定级别的 logger；级别由 LOG_LEVEL 控制，zod 会在 config 里再校验一次合法性 */
export const logger = pino({
    level: process.env.LOG_LEVEL ?? "info",
    base: { service: "llm-gateway" },
});
