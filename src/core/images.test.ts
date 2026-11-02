import { describe, expect, it } from "vitest";
import { ERROR_CODES, GatewayError } from "../errors.ts";
import { MAX_IMAGE_BYTES, normalizeImageResponse } from "./images.ts";

function recordingDownloader(result = "DOWNLOADED_BASE64") {
    const calls: { url: string; maxBytes: number }[] = [];
    const download = async (url: string, maxBytes: number): Promise<string> => {
        calls.push({ url, maxBytes });
        return result;
    };
    return { download, calls };
}

function codeOf(action: () => Promise<unknown>): Promise<string> {
    return action().then(
        () => {
            throw new Error("预期抛错但没有");
        },
        (error: unknown) => {
            if (error instanceof GatewayError) return error.code;
            throw error;
        },
    );
}

describe("图片响应归一化", () => {
    it("上游已经给 b64 时原样保留，不触发下载", async () => {
        const { download, calls } = recordingDownloader();
        const result = (await normalizeImageResponse(
            { created: 123, data: [{ b64_json: "AAAA" }] },
            download,
        )) as { created: number; data: { b64_json: string }[] };

        expect(result.created).toBe(123);
        expect(result.data[0]?.b64_json).toBe("AAAA");
        expect(calls).toHaveLength(0);
    });

    it("上游只给 url 时下载并转成 b64_json", async () => {
        const { download, calls } = recordingDownloader("TWFkZQ==");
        const result = (await normalizeImageResponse(
            { data: [{ url: "https://example.com/a.png", revised_prompt: "一只橘猫" }] },
            download,
        )) as { data: { b64_json: string; url: string; revised_prompt: string }[] };

        expect(calls).toEqual([{ url: "https://example.com/a.png", maxBytes: MAX_IMAGE_BYTES }]);
        expect(result.data[0]?.b64_json).toBe("TWFkZQ==");
        // url 也留着，方便排查
        expect(result.data[0]?.url).toBe("https://example.com/a.png");
        expect(result.data[0]?.revised_prompt).toBe("一只橘猫");
    });

    it("缺 created 时补当前时间戳", async () => {
        const { download } = recordingDownloader();
        const result = (await normalizeImageResponse({ data: [{ b64_json: "AA" }] }, download)) as { created: number };
        expect(typeof result.created).toBe("number");
        expect(result.created).toBeGreaterThan(1_700_000_000);
    });

    it("一 b64 一 url 混合时都归一成 b64", async () => {
        const { download } = recordingDownloader("QQ==");
        const result = (await normalizeImageResponse(
            { data: [{ b64_json: "AA" }, { url: "https://example.com/b.png" }] },
            download,
        )) as { data: { b64_json: string }[] };
        expect(result.data.map((item) => item.b64_json)).toEqual(["AA", "QQ=="]);
    });

    it("响应不是对象时报 bad_gateway", async () => {
        const { download } = recordingDownloader();
        expect(await codeOf(() => normalizeImageResponse("oops", download))).toBe(ERROR_CODES.BAD_GATEWAY);
    });

    it("没有 data 数组时报 bad_gateway", async () => {
        const { download } = recordingDownloader();
        expect(await codeOf(() => normalizeImageResponse({ data: [] }, download))).toBe(ERROR_CODES.BAD_GATEWAY);
        expect(await codeOf(() => normalizeImageResponse({}, download))).toBe(ERROR_CODES.BAD_GATEWAY);
    });

    it("data 项既没有 b64 也没有 url 时报 bad_gateway", async () => {
        const { download } = recordingDownloader();
        expect(await codeOf(() => normalizeImageResponse({ data: [{ nope: 1 }] }, download))).toBe(
            ERROR_CODES.BAD_GATEWAY,
        );
    });
});
