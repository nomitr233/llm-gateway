import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const VERSION = "v1";
const IV_BYTES = 12;
const KEY_PREFIX = "sk-gw-";

/** 主密钥是任意长度字符串，统一哈希成 AES-256 需要的 32 字节 */
function deriveKey(masterSecret: string): Buffer {
    return createHash("sha256").update(masterSecret, "utf8").digest();
}

/**
 * provider key 的落库格式：v1.<iv>.<tag>.<ciphertext>，全部 base64。
 * 带版本前缀是为了以后换算法时能识别旧密文，而不是硬猜。
 */
export function encryptSecret(plaintext: string, masterSecret: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, deriveKey(masterSecret), iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return [VERSION, iv.toString("base64"), cipher.getAuthTag().toString("base64"), ciphertext.toString("base64")].join(".");
}

export function decryptSecret(payload: string, masterSecret: string): string {
    const parts = payload.split(".");
    if (parts.length !== 4 || parts[0] !== VERSION) {
        throw new Error("密文格式不正确（可能不是本网关写入的）");
    }
    const iv = Buffer.from(parts[1] ?? "", "base64");
    const tag = Buffer.from(parts[2] ?? "", "base64");
    const ciphertext = Buffer.from(parts[3] ?? "", "base64");
    const decipher = createDecipheriv(ALGORITHM, deriveKey(masterSecret), iv);
    decipher.setAuthTag(tag);
    // GCM 校验失败会在这里抛错，说明主密钥换了或密文被改过
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

/** 服务 key 只存哈希，库里永远没有明文；查询用哈希做索引，不需要逐条比较 */
export function hashServiceKey(key: string): string {
    return createHash("sha256").update(key, "utf8").digest("hex");
}

/** 需要逐字节比较时用它，避免字符串比较的短路时序泄露 */
export function safeEqualHex(left: string, right: string): boolean {
    const a = Buffer.from(left, "hex");
    const b = Buffer.from(right, "hex");
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
}

export function generateServiceKey(): string {
    return `${KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
}

/** 列表里只显示可辨认的前后缀，够你核对是哪把，又不足以还原 */
export function previewServiceKey(key: string): string {
    return `${key.slice(0, 10)}…${key.slice(-4)}`;
}
