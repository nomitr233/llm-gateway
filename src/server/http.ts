import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { handleAdmin } from "../admin/router.ts";
import type { GatewayConfig } from "../config.ts";
import { downloadAsBase64, normalizeImageResponse } from "../core/images.ts";
import { resolveModel } from "../core/resolve.ts";
import { hashServiceKey } from "../crypto.ts";
import type { ModelEntry, ServiceRow, Snapshot, Store } from "../db/store.ts";
import { asGatewayError, ERROR_CODES, GatewayError, toApiError } from "../errors.ts";
import { logger } from "../logger.ts";
import { runWithFailover } from "../core/failover.ts";

/** 请求体上限，防止一个巨大 body 打穿内存 */
const MAX_BODY_BYTES = 10 * 1024 * 1024;
const BEARER_PREFIX = "Bearer ";

export function createGatewayServer(config: GatewayConfig, store: Store): Server {
    return createServer((request, response) => {
        handleRequest(request, response, config, store).catch((error: unknown) => {
            if (response.headersSent) {
                // 流式已经开始写了，没法再改状态码，只能掐断连接让客户端知道出错
                response.destroy();
                return;
            }
            writeApiError(response, asGatewayError(error));
        });
    });
}

export function startServer(config: GatewayConfig, store: Store): Server {
    const server = createGatewayServer(config, store);
    // 端口被占这类错误如果不接住，就是一段裸栈直接崩，看不出是端口问题
    server.on("error", (error: NodeJS.ErrnoException) => {
        logger.error({ code: error.code, err: error.message }, "HTTP 服务启动失败");
        process.exit(1);
    });
    server.listen(config.port, config.host, () => {
        logger.info({ host: config.host, port: config.port }, "网关已启动");
    });
    return server;
}

async function handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
    config: GatewayConfig,
    store: Store,
): Promise<void> {
    const url = new URL(request.url ?? "/", "http://gateway.local");
    const snapshot = store.getSnapshot();

    if (await handleAdmin(request, response, config, store)) return;

    if (request.method === "GET" && url.pathname === "/health") {
        writeJson(response, 200, {
            ok: true,
            snapshot: {
                version: snapshot.version,
                models: snapshot.modelsByPublicName.size,
                services: snapshot.services.size,
            },
            database: await databaseStatus(store),
        });
        return;
    }

    if (request.method === "GET" && url.pathname === "/v1/models") {
        authenticate(snapshot, request);
        writeJson(response, 200, listModels(snapshot));
        return;
    }

    if (url.pathname === "/v1/chat/completions") {
        if (request.method !== "POST") {
            writeApiError(response, new GatewayError(ERROR_CODES.BAD_REQUEST, `该路由只接受 POST，收到 ${request.method}`));
            return;
        }
        await handleChatCompletions(request, response, config, snapshot);
        return;
    }

    if (url.pathname === "/v1/images/generations") {
        if (request.method !== "POST") {
            writeApiError(response, new GatewayError(ERROR_CODES.BAD_REQUEST, `该路由只接受 POST，收到 ${request.method}`));
            return;
        }
        await handleImageGenerations(request, response, config, snapshot);
        return;
    }

    if (url.pathname === "/v1/audio/speech") {
        if (request.method !== "POST") {
            writeApiError(response, new GatewayError(ERROR_CODES.BAD_REQUEST, `该路由只接受 POST，收到 ${request.method}`));
            return;
        }
        await handleSpeech(request, response, config, snapshot);
        return;
    }

    writeApiError(response, new GatewayError(ERROR_CODES.NOT_FOUND, `未知路由 ${request.method} ${url.pathname}`));
}

async function handleChatCompletions(
    request: IncomingMessage,
    response: ServerResponse,
    config: GatewayConfig,
    snapshot: Snapshot,
): Promise<void> {
    const startedAt = performance.now();
    const requestId = randomUUID();
    const controller = new AbortController();
    response.on("close", () => {
        // 客户端断开就把上游请求一起取消，别让 token 继续烧
        controller.abort();
    });

    const service = authenticate(snapshot, request);
    const body = await readJsonBody(request);
    const requested = typeof body.model === "string" ? body.model : undefined;
    const entry: ModelEntry = resolveModel(snapshot, "text", requested);
    const wantsStream = body.stream === true;
    // 对上游用真实模型名，对下游永远只用登记名
    const upstreamBody = { ...body, model: entry.upstreamModel };

    const result = await runWithFailover(
        [entry.upstream],
        (upstream) =>
            upstream.send({
                body: upstreamBody,
                model: entry.upstreamModel,
                stream: wantsStream,
                signal: controller.signal,
                requestId,
            }),
        { retriesPerUpstream: config.retriesPerUpstream },
    );

    const upstreamStream = result.value.stream;
    if (upstreamStream !== undefined) {
        response.writeHead(result.value.status, {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache",
            connection: "keep-alive",
        });
        logger.info(
            {
                requestId,
                service: service.name,
                model: entry.publicName,
                provider: entry.provider,
                stream: true,
                attempts: result.attempts,
            },
            "流式转发",
        );
        await pipeline(Readable.fromWeb(upstreamStream), response);
        return;
    }

    writeJson(response, result.value.status, result.value.json);
    logger.info(
        {
            requestId,
            service: service.name,
            model: entry.publicName,
            provider: entry.provider,
            stream: false,
            attempts: result.attempts,
            durationMs: Math.round(performance.now() - startedAt),
        },
        "转发完成",
    );
}

async function handleImageGenerations(
    request: IncomingMessage,
    response: ServerResponse,
    config: GatewayConfig,
    snapshot: Snapshot,
): Promise<void> {
    const startedAt = performance.now();
    const requestId = randomUUID();
    const controller = new AbortController();
    response.on("close", () => controller.abort());

    const service = authenticate(snapshot, request);
    const body = await readJsonBody(request);
    const prompt = readPrompt(body);
    const requested = typeof body.model === "string" ? body.model : undefined;
    const entry: ModelEntry = resolveModel(snapshot, "image", requested);

    // 对上游用真实模型名；n 收窄到 4，避免一个请求打出去 10 张图
    const payload: Record<string, unknown> = { ...body, model: entry.upstreamModel, prompt };
    if (body.n !== undefined) payload.n = readImageCount(body.n);

    const result = await runWithFailover(
        [entry.upstream],
        (upstream) =>
            upstream.send({
                body: payload,
                model: entry.upstreamModel,
                stream: false,
                signal: controller.signal,
                requestId,
            }),
        { retriesPerUpstream: config.retriesPerUpstream },
    );

    // 上游只给 url 的时候在这里下载转 b64，下游拿到的永远是同一种格式
    const normalized = await normalizeImageResponse(result.value.json, downloadAsBase64);
    writeJson(response, result.value.status, normalized);

    const data = (normalized as { data?: unknown[] }).data ?? [];
    logger.info(
        {
            requestId,
            service: service.name,
            model: entry.publicName,
            provider: entry.provider,
            images: data.length,
            attempts: result.attempts,
            durationMs: Math.round(performance.now() - startedAt),
        },
        "图片生成完成",
    );
}

async function handleSpeech(
    request: IncomingMessage,
    response: ServerResponse,
    config: GatewayConfig,
    snapshot: Snapshot,
): Promise<void> {
    const startedAt = performance.now();
    const requestId = randomUUID();
    const controller = new AbortController();
    response.on("close", () => controller.abort());

    const service = authenticate(snapshot, request);
    const body = await readJsonBody(request);
    const input = readSpeechInput(body);
    const requested = typeof body.model === "string" ? body.model : undefined;
    const entry: ModelEntry = resolveModel(snapshot, "tts", requested);

    const payload: Record<string, unknown> = { ...body, model: entry.upstreamModel, input };
    // OpenAI 协议里 voice 是必填；调用方没给就用默认音色
    if (payload.voice === undefined) payload.voice = "alloy";

    const result = await runWithFailover(
        [entry.upstream],
        (upstream) =>
            upstream.send({
                body: payload,
                model: entry.upstreamModel,
                stream: false,
                signal: controller.signal,
                requestId,
            }),
        { retriesPerUpstream: config.retriesPerUpstream },
    );

    const binary = result.value.binary;
    if (binary === undefined) {
        throw new GatewayError(ERROR_CODES.INTERNAL_ERROR, "语音上游没有返回二进制音频");
    }

    writeBinary(response, result.value.status, binary.contentType, binary.bytes);
    logger.info(
        {
            requestId,
            service: service.name,
            model: entry.publicName,
            provider: entry.provider,
            bytes: binary.bytes.byteLength,
            contentType: binary.contentType,
            attempts: result.attempts,
            durationMs: Math.round(performance.now() - startedAt),
        },
        "语音合成完成",
    );
}

function readSpeechInput(body: Record<string, unknown>): string {
    const text = body.input ?? body.text;
    if (typeof text !== "string" || text.trim() === "") {
        throw new GatewayError(ERROR_CODES.BAD_REQUEST, "缺少 input 字段");
    }
    return text;
}

function writeBinary(response: ServerResponse, status: number, contentType: string, bytes: Buffer): void {
    if (response.writableEnded || response.destroyed) return;
    response.writeHead(status, { "content-type": contentType, "content-length": bytes.byteLength });
    response.end(bytes);
}

function readPrompt(body: Record<string, unknown>): string {
    const prompt = body.prompt;
    if (typeof prompt !== "string" || prompt.trim() === "") {
        throw new GatewayError(ERROR_CODES.BAD_REQUEST, "缺少 prompt 字段");
    }
    return prompt;
}

function readImageCount(raw: unknown): number {
    const value = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isInteger(value) || value < 1 || value > 4) {
        throw new GatewayError(ERROR_CODES.BAD_REQUEST, "n 必须是 1..4 的整数");
    }
    return value;
}

function authenticate(snapshot: Snapshot, request: IncomingMessage): ServiceRow {
    const header = request.headers.authorization;
    if (typeof header !== "string" || !header.startsWith(BEARER_PREFIX)) {
        throw new GatewayError(ERROR_CODES.INVALID_API_KEY, "缺少 Authorization: Bearer <服务 key>");
    }
    const key = header.slice(BEARER_PREFIX.length).trim();
    if (key === "") {
        throw new GatewayError(ERROR_CODES.INVALID_API_KEY, "服务 key 为空");
    }
    const service = snapshot.servicesByKeyHash.get(hashServiceKey(key));
    if (service === undefined) {
        throw new GatewayError(ERROR_CODES.INVALID_API_KEY, "服务 key 无效");
    }
    if (!service.enabled) {
        throw new GatewayError(ERROR_CODES.PROJECT_DISABLED, `服务 "${service.name}" 已被禁用`);
    }
    return service;
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    let size = 0;

    for await (const chunk of request) {
        const buffer = chunk as Buffer;
        size += buffer.length;
        if (size > MAX_BODY_BYTES) {
            throw new GatewayError(ERROR_CODES.BAD_REQUEST, `请求体超过 ${MAX_BODY_BYTES} 字节上限`);
        }
        chunks.push(buffer);
    }

    if (size === 0) {
        throw new GatewayError(ERROR_CODES.BAD_REQUEST, "请求体为空");
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
        throw new GatewayError(ERROR_CODES.BAD_REQUEST, "请求体不是合法 JSON");
    }

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new GatewayError(ERROR_CODES.BAD_REQUEST, "请求体必须是 JSON 对象");
    }
    return parsed as Record<string, unknown>;
}

/** 健康检查只报告状态，不因为数据库抖动就把整个网关判定为不可用 */
async function databaseStatus(store: Store): Promise<unknown> {
    try {
        const status = await store.pingDatabase();
        return { up: true, db: status.db, user: status.user };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { up: false, error: message };
    }
}

function listModels(snapshot: Snapshot): unknown {
    const defaults = snapshot.defaultByCategory;
    const data = [...snapshot.modelsByPublicName.values()].map((entry) => ({
        id: entry.publicName,
        object: "model",
        owned_by: entry.provider,
        category: entry.category,
        is_default: defaults.get(entry.category)?.publicName === entry.publicName,
    }));
    return { object: "list", data };
}

function writeJson(response: ServerResponse, status: number, payload: unknown): void {
    if (response.writableEnded || response.destroyed) return;
    const text = JSON.stringify(payload ?? null);
    response.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "content-length": Buffer.byteLength(text),
    });
    response.end(text);
}

function writeApiError(response: ServerResponse, error: GatewayError): void {
    const { status, body } = toApiError(error);
    if (status >= 500) {
        logger.error({ code: error.code, status, upstreamStatus: error.status }, error.message);
    } else {
        logger.warn({ code: error.code, status }, error.message);
    }
    writeJson(response, status, body);
}
