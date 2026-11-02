import { describe, expect, it } from "vitest";
import { isAllowedAddress } from "./access.ts";

const loopbackOnly = ["127.0.0.1", "::1"];

describe("面板访问白名单", () => {
    it("默认只放行回环地址", () => {
        expect(isAllowedAddress("127.0.0.1", loopbackOnly)).toBe(true);
        expect(isAllowedAddress("::1", loopbackOnly)).toBe(true);
        expect(isAllowedAddress("10.0.0.5", loopbackOnly)).toBe(false);
        expect(isAllowedAddress(undefined, loopbackOnly)).toBe(false);
    });

    it("IPv4-mapped IPv6 会被归一化", () => {
        expect(isAllowedAddress("::ffff:172.18.0.1", ["172.18.0.1"])).toBe(true);
    });

    it("容器网桥 IP 可以通过显式配置放行", () => {
        const allowed = ["127.0.0.1", "::1", "172.18.0.1"];
        expect(isAllowedAddress("172.18.0.1", allowed)).toBe(true);
        expect(isAllowedAddress("172.18.0.2", allowed)).toBe(false);
    });

    it("支持 IPv4 CIDR", () => {
        expect(isAllowedAddress("172.18.5.9", ["172.16.0.0/12"])).toBe(true);
        expect(isAllowedAddress("172.32.0.1", ["172.16.0.0/12"])).toBe(false);
        expect(isAllowedAddress("192.168.1.7", ["192.168.1.0/24"])).toBe(true);
        expect(isAllowedAddress("192.168.2.7", ["192.168.1.0/24"])).toBe(false);
    });

    it("/32 等价于精确匹配，/0 放行全部", () => {
        expect(isAllowedAddress("10.1.2.3", ["10.1.2.3/32"])).toBe(true);
        expect(isAllowedAddress("10.1.2.4", ["10.1.2.3/32"])).toBe(false);
        expect(isAllowedAddress("8.8.8.8", ["0.0.0.0/0"])).toBe(true);
    });

    it("非法规则被跳过而不是抛错", () => {
        expect(isAllowedAddress("10.0.0.1", ["", "  ", "not-an-ip", "10.0.0.1/99"])).toBe(false);
        expect(isAllowedAddress("10.0.0.1", ["garbage", "10.0.0.1"])).toBe(true);
    });
});
