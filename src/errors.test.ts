import { describe, expect, it } from "vitest";
import { ERROR_CODES, GatewayError, asGatewayError, isRetryable, toApiError, toHttpStatus } from "./errors.ts";

describe("错误码 → HTTP 状态码", () => {
    it("鉴权和项目状态按 spec 的契约映射", () => {
        expect(toHttpStatus(new GatewayError(ERROR_CODES.INVALID_API_KEY, "x"))).toBe(401);
        expect(toHttpStatus(new GatewayError(ERROR_CODES.PROJECT_DISABLED, "x"))).toBe(403);
        expect(toHttpStatus(new GatewayError(ERROR_CODES.QUOTA_EXCEEDED, "x"))).toBe(429);
    });

    it("模型相关的客户端错误统一 400", () => {
        expect(toHttpStatus(new GatewayError(ERROR_CODES.UNKNOWN_MODEL, "x"))).toBe(400);
        expect(toHttpStatus(new GatewayError(ERROR_CODES.MODEL_CATEGORY_MISMATCH, "x"))).toBe(400);
        expect(toHttpStatus(new GatewayError(ERROR_CODES.NO_DEFAULT_MODEL, "x"))).toBe(400);
    });

    it("上游故障映射成 502 / 504", () => {
        expect(toHttpStatus(new GatewayError(ERROR_CODES.BAD_GATEWAY, "x"))).toBe(502);
        expect(toHttpStatus(new GatewayError(ERROR_CODES.UPSTREAM_TIMEOUT, "x"))).toBe(504);
    });

    it("上游 4xx 原样透传状态码", () => {
        const error = new GatewayError(ERROR_CODES.UPSTREAM_ERROR, "x", { status: 429 });
        expect(toHttpStatus(error)).toBe(429);
    });

    it("上游 4xx 越界时收敛回 4xx 区间", () => {
        expect(toHttpStatus(new GatewayError(ERROR_CODES.UPSTREAM_ERROR, "x", { status: 599 }))).toBe(499);
        expect(toHttpStatus(new GatewayError(ERROR_CODES.UPSTREAM_ERROR, "x"))).toBe(400);
    });
});

describe("可重试判定", () => {
    it("只有上游侧暂时性故障值得重试", () => {
        expect(isRetryable(new GatewayError(ERROR_CODES.BAD_GATEWAY, "x"))).toBe(true);
        expect(isRetryable(new GatewayError(ERROR_CODES.UPSTREAM_TIMEOUT, "x"))).toBe(true);
    });

    it("客户端错误和上游 4xx 不重试", () => {
        expect(isRetryable(new GatewayError(ERROR_CODES.UPSTREAM_ERROR, "x", { status: 400 }))).toBe(false);
        expect(isRetryable(new GatewayError(ERROR_CODES.UNKNOWN_MODEL, "x"))).toBe(false);
        expect(isRetryable(new GatewayError(ERROR_CODES.INVALID_API_KEY, "x"))).toBe(false);
        expect(isRetryable(new Error("普通异常"))).toBe(false);
    });
});

describe("对外错误体", () => {
    it("是 OpenAI 风格的三字段结构", () => {
        const { status, body } = toApiError(new GatewayError(ERROR_CODES.INVALID_API_KEY, "key 无效"));
        expect(status).toBe(401);
        expect(body).toEqual({
            error: { message: "key 无效", type: "authentication_error", code: "invalid_api_key" },
        });
    });

    it("任意异常都能收敛成 GatewayError", () => {
        expect(asGatewayError(new Error("boom")).code).toBe(ERROR_CODES.INTERNAL_ERROR);
        expect(asGatewayError("字符串异常").message).toBe("字符串异常");
        const existing = new GatewayError(ERROR_CODES.BAD_REQUEST, "原样返回");
        expect(asGatewayError(existing)).toBe(existing);
    });
});
