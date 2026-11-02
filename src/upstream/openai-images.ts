import { ERROR_CODES, GatewayError } from "../errors.ts";
import type { Upstream, UpstreamOptions, UpstreamRequest, UpstreamResult } from "./provider.ts";
import { callUpstream, parseJsonBody, readBodyText, requireOk } from "./transport.ts";

/**
 * OpenAI 兼容的生图协议：POST {baseUrl}/images/generations。
 * 不额外塞 response_format，因为不是所有兼容实现都认；拿到的 data 由上层统一成 b64。
 */
export class OpenAIImagesUpstream implements Upstream {
    readonly name: string;
    private readonly options: UpstreamOptions;
    private readonly endpoint: string;

    constructor(options: UpstreamOptions) {
        this.name = options.name;
        this.options = options;
        this.endpoint = `${options.baseUrl}/images/generations`;
    }

    async send(request: UpstreamRequest): Promise<UpstreamResult> {
        if (request.stream) {
            throw new GatewayError(ERROR_CODES.BAD_REQUEST, "生图不支持流式");
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

        return { status: response.status, headers: response.headers, json: parseJsonBody(await readBodyText(response)) };
    }
}
