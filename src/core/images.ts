import { ERROR_CODES, GatewayError } from "../errors.ts";

/** 单张图上限，和请求体上限分开：图是二进制，走 base64 后还会膨胀 ~33% */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 60_000;

export type ImageDownloader = (url: string, maxBytes: number, timeoutMs: number) => Promise<string>;

/**
 * 把上游的图片响应统一成 { data: [{ b64_json }] }。
 * 上游只给 url 时下载转 base64——下游拿到的格式永远是同一种，不用为每家厂商写分支。
 */
export async function normalizeImageResponse(payload: unknown, download: ImageDownloader): Promise<unknown> {
    if (typeof payload !== "object" || payload === null) {
        throw new GatewayError(ERROR_CODES.BAD_GATEWAY, "上游返回的图片响应不是 JSON 对象");
    }

    const record = payload as Record<string, unknown>;
    const data = record.data;
    if (!Array.isArray(data) || data.length === 0) {
        throw new GatewayError(ERROR_CODES.BAD_GATEWAY, "上游返回的图片响应里没有 data 数组");
    }

    const normalized: Record<string, unknown>[] = [];
    for (const item of data) {
        if (typeof item !== "object" || item === null) {
            throw new GatewayError(ERROR_CODES.BAD_GATEWAY, "上游返回的 data 项不是对象");
        }
        const datum = item as Record<string, unknown>;
        if (typeof datum.b64_json === "string" && datum.b64_json !== "") {
            normalized.push(datum);
            continue;
        }
        if (typeof datum.url === "string" && datum.url !== "") {
            const base64 = await download(datum.url, MAX_IMAGE_BYTES, DOWNLOAD_TIMEOUT_MS);
            normalized.push({ ...datum, b64_json: base64 });
            continue;
        }
        throw new GatewayError(ERROR_CODES.BAD_GATEWAY, "上游返回的图片既没有 b64_json 也没有 url");
    }

    return { ...record, created: typeof record.created === "number" ? record.created : Math.floor(Date.now() / 1000), data: normalized };
}

/** 下载上游给的临时图片；超过上限直接失败，避免把大文件读进内存 */
export async function downloadAsBase64(url: string, maxBytes: number, timeoutMs: number): Promise<string> {
    const timeout = AbortSignal.timeout(timeoutMs);
    let response: Response;
    try {
        response = await fetch(url, { signal: timeout, redirect: "follow" });
    } catch (error) {
        throw new GatewayError(ERROR_CODES.BAD_GATEWAY, `下载上游图片失败：${url}`, { cause: error });
    }

    if (!response.ok) {
        throw new GatewayError(ERROR_CODES.BAD_GATEWAY, `下载上游图片失败：HTTP ${response.status}`, {
            status: response.status,
        });
    }

    const declared = Number(response.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > maxBytes) {
        throw new GatewayError(ERROR_CODES.BAD_GATEWAY, `上游图片超过 ${maxBytes} 字节上限（声明 ${declared}）`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > maxBytes) {
        throw new GatewayError(ERROR_CODES.BAD_GATEWAY, `上游图片超过 ${maxBytes} 字节上限（实际 ${buffer.byteLength}）`);
    }
    return buffer.toString("base64");
}
