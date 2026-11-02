import { describe, expect, it } from "vitest";
import { encryptSecret, decryptSecret, generateServiceKey, hashServiceKey, previewServiceKey, safeEqualHex } from "./crypto.ts";

describe("provider key 加密", () => {
    it("加密后能原样解回来", () => {
        const ciphertext = encryptSecret("sk-upstream-secret", "master-secret");
        expect(ciphertext.startsWith("v1.")).toBe(true);
        expect(ciphertext).not.toContain("sk-upstream-secret");
        expect(decryptSecret(ciphertext, "master-secret")).toBe("sk-upstream-secret");
    });

    it("同一明文两次加密的结果不同（IV 随机）", () => {
        const first = encryptSecret("sk-x", "master-secret");
        const second = encryptSecret("sk-x", "master-secret");
        expect(first).not.toBe(second);
    });

    it("主密钥不对时解密失败，而不是给出乱码", () => {
        const ciphertext = encryptSecret("sk-x", "master-secret");
        expect(() => decryptSecret(ciphertext, "another-secret")).toThrow();
    });

    it("密文被篡改时解密失败（GCM 认证生效）", () => {
        const ciphertext = encryptSecret("sk-x", "master-secret");
        const parts = ciphertext.split(".");
        const tampered = [parts[0], parts[1], parts[2], Buffer.from("evil").toString("base64")].join(".");
        expect(() => decryptSecret(tampered, "master-secret")).toThrow();
    });

    it("格式不对的密文给出明确错误", () => {
        expect(() => decryptSecret("not-a-ciphertext", "master-secret")).toThrow(/密文格式/);
    });
});

describe("服务 key", () => {
    it("生成的 key 带前缀且长度足够", () => {
        const key = generateServiceKey();
        expect(key.startsWith("sk-gw-")).toBe(true);
        expect(key.length).toBeGreaterThan(40);
    });

    it("哈希是稳定的 sha256 hex（64 字符）", () => {
        const key = "sk-gw-abc";
        expect(hashServiceKey(key)).toBe(hashServiceKey(key));
        expect(hashServiceKey(key)).toMatch(/^[0-9a-f]{64}$/);
        expect(hashServiceKey(key)).not.toBe(hashServiceKey("sk-gw-abd"));
    });

    it("预览只暴露首尾", () => {
        const preview = previewServiceKey("sk-gw-1234567890abcdefg");
        expect(preview).toContain("…");
        expect(preview).not.toBe("sk-gw-1234567890abcdefg");
    });

    it("常数时间比较能识别不同的哈希", () => {
        const left = hashServiceKey("a");
        expect(safeEqualHex(left, left)).toBe(true);
        expect(safeEqualHex(left, hashServiceKey("b"))).toBe(false);
    });
});
