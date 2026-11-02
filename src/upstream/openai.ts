import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { ERROR_CODES, GatewayError } from "../errors.ts";
import type { Upstream, UpstreamOptions, UpstreamRequest, UpstreamResult } from "./provider.ts";
import { callUpstream, parseJsonBody, readBodyText, requireOk } from "./transport.ts";

/**
 * OpenAI 兼容的对话协议：POST {baseUrl}/chat/completions。
 */
export class OpenAIUpstream implements Upstream {
    readonly name: string;
    private readonly options: UpstreamOptions;
    private readonly endpoint: string;

    constructor(options: UpstreamOptions) {
        this.name = options.name;
        this.options = options;
        this.endpoint = `${options.baseUrl}/chat/completions`;
    }

    async send(request: UpstreamRequest): Promise<UpstreamResult> {
        const response = await callUpstream({
            url: this.endpoint,
            apiKey: this.options.apiKey,
            requestId: request.requestId,
            body: request.body,
            stream: request.stream,
            signal: request.signal,
            timeoutMs: this.options.timeoutMs,
            name: this.name,
        });
        await requireOk(response, this.name);

        if (request.stream) {
            if (response.body === null) {
                throw new GatewayError(ERROR_CODES.INTERNAL_ERROR, `上游 ${this.name} 声明流式但没有返回响应体`);
            }
            // undici 的 Response.body 与 node:stream/web 的泛型不完全兼容，这里是唯一一处转换点
            const stream = response.body as unknown as NodeReadableStream<Uint8Array>;
            return { status: response.status, headers: response.headers, stream };
        }

        return { status: response.status, headers: response.headers, json: parseJsonBody(await readBodyText(response)) };
    }
}
