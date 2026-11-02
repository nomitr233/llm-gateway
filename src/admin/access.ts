/**
 * 面板访问控制。
 *
 * 为什么不用 `remoteAddress === 127.0.0.1` 判断：容器化部署时端口是 DNAT 进来的，
 * 容器看到的源地址是网桥网关 IP（如 172.18.0.1），回环判断会把人挡在门外。
 * 所以规则做成白名单：默认只允许回环，容器里显式加上那一台网关。
 */
export function isAllowedAddress(address: string | undefined, allowed: readonly string[]): boolean {
    if (address === undefined || address === "") return false;
    // IPv4-mapped IPv6 统一成 IPv4 再比
    const normalized = address.startsWith("::ffff:") ? address.slice("::ffff:".length) : address;

    for (const entry of allowed) {
        const pattern = entry.trim();
        if (pattern === "") continue;
        if (pattern === normalized) return true;

        const separator = pattern.indexOf("/");
        if (separator === -1) continue;

        const network = ipv4ToInt(pattern.slice(0, separator));
        const suffix = Number(pattern.slice(separator + 1));
        const value = ipv4ToInt(normalized);
        if (network === null || value === null) continue;
        if (!Number.isInteger(suffix) || suffix < 0 || suffix > 32) continue;

        const mask = suffix === 0 ? 0 : (0xffffffff << (32 - suffix)) >>> 0;
        if (((value & mask) >>> 0) === ((network & mask) >>> 0)) return true;
    }
    return false;
}

/** 返回 null 表示不是合法 IPv4，调用方跳过该规则而不是报错 */
function ipv4ToInt(value: string): number | null {
    const parts = value.split(".");
    if (parts.length !== 4) return null;
    let result = 0;
    for (const part of parts) {
        const octet = Number(part);
        if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
        result = result * 256 + octet;
    }
    return result;
}
