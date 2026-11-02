import type { Category, ModelEntry, Snapshot } from "../db/store.ts";
import { ERROR_CODES, GatewayError } from "../errors.ts";

/**
 * 模型解析规则（纯函数，便于单测）：
 *   指定了 model  → 必须已登记，且类别要和端点匹配
 *   没指定 model  → 用该类别的默认模型
 */
export function resolveModel(snapshot: Snapshot, category: Category, requested: string | undefined): ModelEntry {
    if (requested !== undefined && requested !== "") {
        const entry = snapshot.modelsByPublicName.get(requested);
        if (entry === undefined) {
            throw new GatewayError(ERROR_CODES.UNKNOWN_MODEL, `模型 "${requested}" 未登记`);
        }
        if (entry.category !== category) {
            throw new GatewayError(
                ERROR_CODES.MODEL_CATEGORY_MISMATCH,
                `模型 "${requested}" 属于 ${entry.category} 类别，不能用于 ${category} 端点`,
            );
        }
        return entry;
    }

    const fallback = snapshot.defaultByCategory.get(category);
    if (fallback === undefined) {
        throw new GatewayError(ERROR_CODES.NO_DEFAULT_MODEL, `${category} 类别还没有设置默认模型`);
    }
    return fallback;
}
