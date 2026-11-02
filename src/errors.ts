export const ERROR_CODES = {
    INVALID_API_KEY: "invalid_api_key",
    PROJECT_DISABLED: "project_disabled",
    QUOTA_EXCEEDED: "quota_exceeded",
    BAD_REQUEST: "bad_request",
    UNKNOWN_MODEL: "unknown_model",
    MODEL_CATEGORY_MISMATCH: "model_category_mismatch",
    NO_DEFAULT_MODEL: "no_default_model",
    NOT_FOUND: "not_found",
    UPSTREAM_ERROR: "upstream_error",
    BAD_GATEWAY: "bad_gateway",
    UPSTREAM_TIMEOUT: "upstream_timeout",
    CONFIG_ERROR: "config_error",
    INTERNAL_ERROR: "internal_error",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/** OpenAI 风格错误体里的 type 字段，客户端常拿它做粗分类 */
export type ApiErrorType =
    | "invalid_request_error"
    | "authentication_error"
    | "permission_error"
    | "rate_limit_error"
    | "not_found_error"
    | "api_error"
    | "server_error";

interface CodeMeta {
    status: number;
    type: ApiErrorType;
}

/**
 * 错误码的唯一定义处：状态码、错误类型、是否可重试都从这张表来。
 * 加一个新错误码 = 在这里加一行，不要在别处再写一份 switch。
 */
const CODE_META: Record<ErrorCode, CodeMeta> = {
    [ERROR_CODES.INVALID_API_KEY]: { status: 401, type: "authentication_error" },
    [ERROR_CODES.PROJECT_DISABLED]: { status: 403, type: "permission_error" },
    [ERROR_CODES.QUOTA_EXCEEDED]: { status: 429, type: "rate_limit_error" },
    [ERROR_CODES.BAD_REQUEST]: { status: 400, type: "invalid_request_error" },
    [ERROR_CODES.UNKNOWN_MODEL]: { status: 400, type: "invalid_request_error" },
    [ERROR_CODES.MODEL_CATEGORY_MISMATCH]: { status: 400, type: "invalid_request_error" },
    [ERROR_CODES.NO_DEFAULT_MODEL]: { status: 400, type: "invalid_request_error" },
    [ERROR_CODES.NOT_FOUND]: { status: 404, type: "not_found_error" },
    // 上游 4xx 原样透传状态码，这里的 400 只是兜底
    [ERROR_CODES.UPSTREAM_ERROR]: { status: 400, type: "invalid_request_error" },
    [ERROR_CODES.BAD_GATEWAY]: { status: 502, type: "api_error" },
    [ERROR_CODES.UPSTREAM_TIMEOUT]: { status: 504, type: "api_error" },
    [ERROR_CODES.CONFIG_ERROR]: { status: 500, type: "server_error" },
    [ERROR_CODES.INTERNAL_ERROR]: { status: 500, type: "server_error" },
};

/** 只有上游侧的暂时性故障值得换个 provider 再试 */
const RETRYABLE_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
    ERROR_CODES.BAD_GATEWAY,
    ERROR_CODES.UPSTREAM_TIMEOUT,
]);

export interface GatewayErrorMeta {
    /** 上游原始 HTTP 状态码；没走到 HTTP 层时为 null */
    status?: number;
    /** 是否已经在别处试过 */
    retried?: boolean;
    /** 上游原始响应体，用于诊断，不返回给调用方 */
    body?: unknown;
    /** 底层异常，保留原始堆栈 */
    cause?: unknown;
}

export class GatewayError extends Error {
    override name = "GatewayError";
    code: ErrorCode;
    status: number | null;
    retried: boolean;
    body: unknown;

    constructor(code: ErrorCode, message: string, meta: GatewayErrorMeta = {}) {
        super(message, meta.cause === undefined ? undefined : { cause: meta.cause });
        this.code = code;
        this.status = meta.status ?? null;
        this.retried = meta.retried ?? false;
        this.body = meta.body;
    }
}

export interface ApiErrorBody {
    error: {
        message: string;
        type: ApiErrorType;
        code: ErrorCode;
    };
}

export function isGatewayError(error: unknown): error is GatewayError {
    return error instanceof GatewayError;
}

export function isRetryable(error: unknown): boolean {
    return error instanceof GatewayError && RETRYABLE_CODES.has(error.code);
}

export function toHttpStatus(error: GatewayError): number {
    if (error.code === ERROR_CODES.UPSTREAM_ERROR) {
        const status = error.status ?? 400;
        return Math.min(Math.max(status, 400), 499);
    }
    return CODE_META[error.code].status;
}

export function toApiError(error: GatewayError): { status: number; body: ApiErrorBody } {
    return {
        status: toHttpStatus(error),
        body: { error: { message: error.message, type: CODE_META[error.code].type, code: error.code } },
    };
}

/** 把任意异常收敛成 GatewayError，保证对外永远只有一种错误形状 */
export function asGatewayError(error: unknown): GatewayError {
    if (error instanceof GatewayError) return error;
    const message = error instanceof Error ? error.message : String(error);
    return new GatewayError(ERROR_CODES.INTERNAL_ERROR, message, { cause: error });
}
