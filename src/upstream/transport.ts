import { ERROR_CODES, GatewayError } from "../errors.ts";

export interface TransportCall {
    url: string;
    apiKey: string;
    requestId: string;
    body: unknown;
    stream: boolean;
    signal: AbortSignal;
    timeoutMs: number;
    /** 只用于报错信息里指出是哪个上游 */
    name: string;
}

/**
 * 所有上游请求的唯一出口：超时、鉴权头、错误翻译都在这里，
 * 适配器只负责拼 URL 和解释响应。
 */
export async function callUpstream(call: TransportCall): Promise<Response> {
    const timeout = AbortSignal.timeout(call.timeoutMs);
    const signal = AbortSignal.any([call.signal, timeout]);

    try {
        return await fetch(call.url, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                accept: call.stream ? "text/event-stream" : "application/json",
                authorization: `Bearer ${call.apiKey}`,
                "x-request-id": call.requestId,
            },
            body: JSON.stringify(call.body),
            signal,
        });
    } catch (error) {
        if (timeout.aborted) {
            throw new GatewayError(ERROR_CODES.UPSTREAM_TIMEOUT, `上游 ${call.name} 超时（${call.timeoutMs}ms）`, {
                cause: error,
            });
        }
        if (call.signal.aborted) {
            throw new GatewayError(ERROR_CODES.BAD_GATEWAY, "客户端已断开", { cause: error });
        }
        throw new GatewayError(ERROR_CODES.BAD_GATEWAY, `无法连接上游 ${call.name}`, { cause: error });
    }
}

/** 上游非 2xx 时翻译成 GatewayError，5xx 可重试、4xx 原样透传状态码 */
export async function requireOk(response: Response, name: string): Promise<Response> {
    if (response.ok) return response;
    const body = parseJsonBody(await readBodyText(response));
    throw new GatewayError(
        response.status >= 500 ? ERROR_CODES.BAD_GATEWAY : ERROR_CODES.UPSTREAM_ERROR,
        `上游 ${name} 返回 ${response.status}`,
        { status: response.status, body },
    );
}

export async function readBodyText(response: Response): Promise<string> {
    try {
        return await response.text();
    } catch {
        return "";
    }
}

export function parseJsonBody(text: string): unknown {
    if (text === "") return undefined;
    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
}
