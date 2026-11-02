import { describe, expect, it } from "vitest";
import type { ModelEntry, Snapshot } from "../db/store.ts";
import { ERROR_CODES, GatewayError } from "../errors.ts";
import type { Upstream } from "../upstream/provider.ts";
import { resolveModel } from "./resolve.ts";

const stubUpstream: Upstream = {
    name: "demo",
    send: async () => ({ status: 200, headers: new Headers(), json: {} }),
};

function entry(publicName: string, category: ModelEntry["category"]): ModelEntry {
    return {
        publicName,
        category,
        upstreamModel: `${publicName}-upstream`,
        provider: "demo",
        upstream: stubUpstream,
    };
}

function snapshotOf(models: ModelEntry[], defaults: ModelEntry[]): Snapshot {
    return {
        version: 1,
        services: new Map(),
        servicesByKeyHash: new Map(),
        modelsByPublicName: new Map(models.map((model) => [model.publicName, model])),
        defaultByCategory: new Map(defaults.map((model) => [model.category, model])),
    };
}

function codeOf(action: () => unknown): string {
    try {
        action();
    } catch (error) {
        if (error instanceof GatewayError) return error.code;
        throw error;
    }
    throw new Error("预期抛错但没有");
}

const chatModel = entry("chat-default", "text");
const imageModel = entry("image-default", "image");
const snapshot = snapshotOf([chatModel, imageModel], [chatModel]);

describe("模型解析", () => {
    it("指定已登记模型时直接命中", () => {
        expect(resolveModel(snapshot, "text", "chat-default").upstreamModel).toBe("chat-default-upstream");
    });

    it("未登记的模型报 unknown_model", () => {
        expect(codeOf(() => resolveModel(snapshot, "text", "nope"))).toBe(ERROR_CODES.UNKNOWN_MODEL);
    });

    it("类别不匹配时报 model_category_mismatch", () => {
        expect(codeOf(() => resolveModel(snapshot, "text", "image-default"))).toBe(ERROR_CODES.MODEL_CATEGORY_MISMATCH);
    });

    it("省略模型时使用该类别默认模型", () => {
        expect(resolveModel(snapshot, "text", undefined).publicName).toBe("chat-default");
    });

    it("空字符串等同于省略", () => {
        expect(resolveModel(snapshot, "text", "").publicName).toBe("chat-default");
    });

    it("该类别没有默认模型时报 no_default_model", () => {
        expect(codeOf(() => resolveModel(snapshot, "image", undefined))).toBe(ERROR_CODES.NO_DEFAULT_MODEL);
    });

    it("没有默认模型但指定了具体模型时照常工作", () => {
        expect(resolveModel(snapshot, "image", "image-default").publicName).toBe("image-default");
    });
});
