import type { ReadableStream as NodeReadableStream } from "node:stream/web";

/** 构造一个上游适配器需要的东西；凭据在这里已经是明文，只在内存里存在 */
export interface UpstreamOptions {
    name: string;
    baseUrl: string;
    apiKey: string;
    timeoutMs: number;
}

/** 一次转发到上游的请求上下文 */
export interface UpstreamRequest {
    /** 已经换成真实模型名的请求体 */
    body: unknown;
    model: string;
    stream: boolean;
    /** 客户端断开时触发，用于取消上游请求 */
    signal: AbortSignal;
    requestId: string;
}

export interface UpstreamResult {
    status: number;
    headers: Headers;
    /** 流式时存在。用 node:stream/web 的类型，避免把 undici 的 Response 类型漏到接口上 */
    stream?: NodeReadableStream<Uint8Array>;
    /** 非流式时存在，已解析成对象 */
    json?: unknown;
    /** 二进制响应（语音合成等） */
    binary?: { contentType: string; bytes: Buffer };
}

/**
 * 上游适配器。新增协议（anthropic / openai_images …）= 新增一个实现，
 * 路由和重试层都不用动。
 */
export interface Upstream {
    readonly name: string;
    send(request: UpstreamRequest): Promise<UpstreamResult>;
}
