import { ERROR_CODES, GatewayError } from "../errors.ts";
import type { Upstream, UpstreamOptions, UpstreamRequest, UpstreamResult } from "./provider.ts";
import { callUpstream, requireOk } from "./transport.ts";

/**
 * OpenAI 兼容的语音合成协议：POST {baseUrl}/audio/speech。
 * 返回的是二进制音频，不是 JSON，所以走 binary 通道。
 */
export class OpenAISpeechUpstream implements Upstream {
    readonly name: string;
    private readonly options: UpstreamOptions;
    private readonly endpoint: string;

    constructor(options: UpstreamOptions) {
        this.name = options.name;
        this.options = options;
        this.endpoint = `${options.baseUrl}/audio/speech`;
    }

    async send(request: UpstreamRequest): Promise<UpstreamResult> {
        if (request.stream) {
            throw new GatewayError(ERROR_CODES.BAD_REQUEST, "语音合成不支持流式");
        }

        const response = await callUpstream({
            url: this.endpoint,
            apiKey: this.options.apiKey,
            requestId: request.requestId,
            body: request.body,
            stream: false,
            signal: request.signal,
            timeoutMs: this.options.timeoutMs,
            name: this.name,
        });
        await requireOk(response, this.name);

        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.byteLength === 0) {
            throw new GatewayError(ERROR_CODES.BAD_GATEWAY, `上游 ${this.name} 返回了空音频`);
        }

        return {
            status: response.status,
            headers: response.headers,
            binary: {
                contentType: response.headers.get("content-type") ?? "audio/mpeg",
                bytes,
            },
        };
    }
}
