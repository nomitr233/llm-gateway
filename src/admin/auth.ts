import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "gw_admin";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const SESSION_TTL_SECONDS = Math.floor(SESSION_TTL_MS / 1000);

function sign(secret: string, payload: string): string {
    return createHmac("sha256", secret).update(payload).digest("hex");
}

function safeHexEqual(left: string, right: string): boolean {
    const a = Buffer.from(left, "hex");
    const b = Buffer.from(right, "hex");
    if (a.length === 0 || a.length !== b.length) return false;
    return timingSafeEqual(a, b);
}

/** 无状态会话：<过期时间戳>.<HMAC>，不占表、不需要清理 */
export function issueSession(secret: string, now: number = Date.now()): string {
    const expiresAt = now + SESSION_TTL_MS;
    return `${expiresAt}.${sign(secret, String(expiresAt))}`;
}

export function verifySession(secret: string, cookieValue: string | undefined, now: number = Date.now()): boolean {
    if (cookieValue === undefined) return false;
    const separator = cookieValue.indexOf(".");
    if (separator === -1) return false;
    const expiresAt = cookieValue.slice(0, separator);
    const signature = cookieValue.slice(separator + 1);
    const expiry = Number(expiresAt);
    if (!Number.isInteger(expiry) || expiry < now) return false;
    return safeHexEqual(sign(secret, expiresAt), signature);
}

/** 先各自哈希再比较，避免长度差异泄露密码长度 */
export function checkPassword(configured: string, provided: string): boolean {
    const expected = createHash("sha256").update(configured, "utf8").digest();
    const actual = createHash("sha256").update(provided, "utf8").digest();
    return timingSafeEqual(expected, actual);
}

export function readCookie(header: string | undefined, name: string): string | undefined {
    if (header === undefined) return undefined;
    for (const part of header.split(";")) {
        const index = part.indexOf("=");
        if (index === -1) continue;
        if (part.slice(0, index).trim() !== name) continue;
        return decodeURIComponent(part.slice(index + 1).trim());
    }
    return undefined;
}

export function sessionCookie(value: string): string {
    return `${SESSION_COOKIE}=${encodeURIComponent(value)}; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL_SECONDS}`;
}

export function clearedCookie(): string {
    return `${SESSION_COOKIE}=; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=0`;
}
