import { existsSync } from "node:fs";

/**
 * 必须在其它模块之前 import：logger 和 config 都在模块加载期读 process.env，
 * 而 .env 里的值只有在加载之后才可见。
 */
const envFile = new URL("../.env", import.meta.url);
if (existsSync(envFile)) {
    process.loadEnvFile(envFile);
}
