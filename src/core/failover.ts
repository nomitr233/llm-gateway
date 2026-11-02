import { setTimeout as delay } from "node:timers/promises";
import { ERROR_CODES, GatewayError, isRetryable } from "../errors.ts";
import type { Upstream } from "../upstream/provider.ts";

export interface FailoverOptions {
    /** 同一个上游上最多再试几次 */
    retriesPerUpstream: number;
    /** 同上游重试的退避基数：第 n 次等待 backoff * 2^(n-1) */
    backoffMs?: number;
}

export interface FailoverResult<T> {
    value: T;
    upstream: Upstream;
    attempts: number;
}

/**
 * 按配置顺序尝试上游：只有可重试的错误才继续往下走，
 * 4xx 立刻抛出，不浪费其它上游的配额。
 */
export async function runWithFailover<T>(
    upstreams: readonly Upstream[],
    attempt: (upstream: Upstream) => Promise<T>,
    options: FailoverOptions,
): Promise<FailoverResult<T>> {
    if (upstreams.length === 0) {
        throw new GatewayError(ERROR_CODES.UNKNOWN_MODEL, "没有可用于该请求的上游");
    }

    const backoffMs = options.backoffMs ?? 200;
    let attempts = 0;
    let lastError: unknown;

    for (const upstream of upstreams) {
        for (let retry = 0; retry <= options.retriesPerUpstream; retry++) {
            attempts += 1;
            try {
                const value = await attempt(upstream);
                return { value, upstream, attempts };
            } catch (error) {
                lastError = error;
                if (!isRetryable(error)) throw error;
                if (retry < options.retriesPerUpstream) {
                    await delay(backoffMs * 2 ** retry);
                }
            }
        }
    }

    if (lastError instanceof GatewayError) {
        lastError.retried = attempts > 1;
        throw lastError;
    }
    throw new GatewayError(ERROR_CODES.BAD_GATEWAY, "所有上游均失败", {
        cause: lastError,
        retried: attempts > 1,
    });
}
