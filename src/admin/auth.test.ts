import { describe, expect, it } from "vitest";
import { checkPassword, issueSession, readCookie, SESSION_COOKIE, verifySession } from "./auth.ts";

describe("面板会话", () => {
    it("签发的会话可以通过校验", () => {
        const cookie = issueSession("secret");
        expect(verifySession("secret", cookie)).toBe(true);
    });

    it("换了 GATEWAY_SECRET 之后旧会话失效", () => {
        const cookie = issueSession("secret");
        expect(verifySession("another-secret", cookie)).toBe(false);
    });

    it("过期的会话不通过", () => {
        const issuedAt = Date.now() - 13 * 60 * 60 * 1000;
        const cookie = issueSession("secret", issuedAt);
        expect(verifySession("secret", cookie)).toBe(false);
    });

    it("篡改过期时间但没改签名时不通过", () => {
        const cookie = issueSession("secret");
        const [, signature] = cookie.split(".");
        expect(verifySession("secret", `${Date.now() + 999_999}.${signature ?? ""}`)).toBe(false);
    });

    it("格式不对的 cookie 不通过", () => {
        expect(verifySession("secret", undefined)).toBe(false);
        expect(verifySession("secret", "garbage")).toBe(false);
        expect(verifySession("secret", "abc.def")).toBe(false);
    });
});

describe("密码比较", () => {
    it("正确密码通过", () => {
        expect(checkPassword("correct-horse", "correct-horse")).toBe(true);
    });

    it("错误密码和空密码都不通过", () => {
        expect(checkPassword("correct-horse", "wrong")).toBe(false);
        expect(checkPassword("correct-horse", "")).toBe(false);
    });
});

describe("cookie 解析", () => {
    it("能从多个 cookie 里挑出目标", () => {
        expect(readCookie("a=1; gw_admin=xyz; b=2", SESSION_COOKIE)).toBe("xyz");
    });

    it("没有目标 cookie 时返回 undefined", () => {
        expect(readCookie("a=1", SESSION_COOKIE)).toBeUndefined();
        expect(readCookie(undefined, SESSION_COOKIE)).toBeUndefined();
    });

    it("值里的编码会被还原", () => {
        expect(readCookie(`gw_admin=${encodeURIComponent("a b")}`, SESSION_COOKIE)).toBe("a b");
    });
});
