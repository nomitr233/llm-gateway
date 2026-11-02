import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { GatewayConfig } from "../config.ts";
import { encryptSecret, generateServiceKey, hashServiceKey, previewServiceKey } from "../crypto.ts";
import { isCategory, type Store } from "../db/store.ts";
import { isAllowedAddress } from "./access.ts";
import {
    checkPassword,
    clearedCookie,
    issueSession,
    readCookie,
    SESSION_COOKIE,
    sessionCookie,
    verifySession,
} from "./auth.ts";
import { escapeHtml, layout, loginPage } from "./html.ts";
import { dashboardPage, modelsPage, providersPage, servicesPage } from "./pages.ts";

const MAX_FORM_BYTES = 64 * 1024;

/** 新建 key 的明文只在内存里放 60 秒，够页面渲染一次，绝不进 URL */
const pendingKeys = new Map<string, { key: string; expiresAt: number }>();

function rememberKey(key: string): string {
    const token = randomUUID();
    pendingKeys.set(token, { key, expiresAt: Date.now() + 60_000 });
    return token;
}

function takeKey(token: string | null): string | undefined {
    if (token === null) return undefined;
    const entry = pendingKeys.get(token);
    pendingKeys.delete(token);
    if (entry === undefined || entry.expiresAt < Date.now()) return undefined;
    return entry.key;
}

export async function handleAdmin(
    request: IncomingMessage,
    response: ServerResponse,
    config: GatewayConfig,
    store: Store,
): Promise<boolean> {
    const url = new URL(request.url ?? "/", "http://gateway.local");
    if (!url.pathname.startsWith("/admin")) return false;
    const method = request.method ?? "GET";

    if (config.adminPassword === null) {
        sendHtml(
            response,
            503,
            layout({
                title: "未启用",
                active: "none",
                body: `<h1>管理面板未启用</h1><p class="muted">在 <code>.env</code> 里设置 <code>ADMIN_PASSWORD</code> 后重启网关。</p>`,
            }),
        );
        return true;
    }

    // 面板只允许白名单来源访问：默认回环；容器部署时配成容器默认网关 IP
    if (!isAllowedAddress(request.socket.remoteAddress, config.adminAllowedIps)) {
        sendHtml(
            response,
            403,
            layout({
                title: "禁止访问",
                active: "none",
                body: `<h1>管理面板只允许白名单地址访问</h1><p class="muted">来源 ${escapeHtml(
                    request.socket.remoteAddress ?? "unknown",
                )} 不在 ADMIN_ALLOWED_IPS 中。</p>`,
            }),
        );
        return true;
    }

    if (url.pathname === "/admin/login") {
        if (method === "POST") {
            const form = await readForm(request);
            const password = form.get("password") ?? "";
            if (!checkPassword(config.adminPassword, password)) {
                sendHtml(response, 401, loginPage("密码不对"));
                return true;
            }
            response.setHeader("set-cookie", sessionCookie(issueSession(config.gatewaySecret)));
            redirect(response, "/admin");
            return true;
        }
        sendHtml(response, 200, loginPage());
        return true;
    }

    if (url.pathname === "/admin/logout" && method === "POST") {
        response.setHeader("set-cookie", clearedCookie());
        redirect(response, "/admin/login");
        return true;
    }

    const session = readCookie(request.headers.cookie, SESSION_COOKIE);
    if (!verifySession(config.gatewaySecret, session)) {
        redirect(response, "/admin/login");
        return true;
    }

    const message = url.searchParams.get("msg") ?? undefined;
    const level = (url.searchParams.get("level") ?? "ok") as "ok" | "warn" | "error";

    if (method === "GET") {
        switch (url.pathname) {
            case "/admin": {
                const counts = await store.query<{ providers: string; models: string; services: string }>(
                    `select (select count(*) from providers) as providers,
                            (select count(*) from models) as models,
                            (select count(*) from services) as services`,
                );
                const snapshot = store.getSnapshot();
                sendHtml(
                    response,
                    200,
                    dashboardPage({
                        providers: Number(counts[0]?.providers ?? 0),
                        models: Number(counts[0]?.models ?? 0),
                        services: Number(counts[0]?.services ?? 0),
                        defaults: [...snapshot.defaultByCategory.values()].map((entry) => ({
                            category: entry.category,
                            publicName: entry.publicName,
                        })),
                        snapshotVersion: snapshot.version,
                        message,
                    }),
                );
                return true;
            }
            case "/admin/providers": {
                const rows = await store.query<{ name: string; base_url: string; timeout_ms: number; enabled: boolean }>(
                    "select name, base_url, timeout_ms, enabled from providers order by name",
                );
                sendHtml(response, 200, providersPage(rows, message));
                return true;
            }
            case "/admin/models": {
                const rows = await store.query<{
                    public_name: string;
                    category: string;
                    upstream_model: string;
                    provider: string;
                    is_default: boolean;
                    enabled: boolean;
                }>(
                    `select m.public_name, m.category, m.upstream_model, p.name as provider, m.is_default, m.enabled
                       from models m join providers p on p.id = m.provider_id
                      order by m.category, m.public_name`,
                );
                const providers = await store.query<{ name: string }>("select name from providers order by name");
                sendHtml(
                    response,
                    200,
                    modelsPage(
                        rows,
                        providers.map((row) => row.name),
                        message,
                    ),
                );
                return true;
            }
            case "/admin/services": {
                const rows = await store.query<{ name: string; key_preview: string; enabled: boolean }>(
                    "select name, key_preview, enabled from services order by name",
                );
                sendHtml(response, 200, servicesPage(rows, takeKey(url.searchParams.get("created")), message));
                return true;
            }
            default:
                sendHtml(response, 404, layout({ title: "找不到页面", active: "none", body: "<h1>404</h1>" }));
                return true;
        }
    }

    if (method !== "POST") {
        sendHtml(response, 405, layout({ title: "方法不允许", active: "none", body: "<h1>405</h1>" }));
        return true;
    }

    try {
        const form = await readForm(request);
        switch (url.pathname) {
            case "/admin/providers": {
                const name = required(form, "name");
                const baseUrl = required(form, "base_url").replace(/\/+$/, "");
                const apiKey = required(form, "api_key");
                const timeoutMs = Number(form.get("timeout_ms") ?? 120_000);
                if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new Error("超时必须是正整数");
                await store.mutate(async (client) => {
                    await client.query(
                        `insert into providers (name, base_url, api_key_ciphertext, timeout_ms)
                         values ($1, $2, $3, $4)
                         on conflict (name) do update
                            set base_url = excluded.base_url,
                                api_key_ciphertext = excluded.api_key_ciphertext,
                                timeout_ms = excluded.timeout_ms,
                                enabled = true`,
                        [name, baseUrl, encryptSecret(apiKey, config.gatewaySecret), timeoutMs],
                    );
                });
                redirect(response, "/admin/providers?msg=" + encodeURIComponent(`上游 ${name} 已保存`));
                return true;
            }
            case "/admin/providers/toggle": {
                const name = required(form, "name");
                const enabled = form.get("enabled") === "true";
                await store.mutate((client) =>
                    client.query("update providers set enabled = $2 where name = $1", [name, enabled]),
                );
                redirect(response, "/admin/providers?msg=" + encodeURIComponent(`${name} 已${enabled ? "启用" : "禁用"}`));
                return true;
            }
            case "/admin/models": {
                const publicName = required(form, "public_name");
                const providerName = required(form, "provider");
                const upstreamModel = required(form, "upstream_model");
                const category = required(form, "category");
                if (!isCategory(category)) throw new Error("类别不合法");
                const makeDefault = form.get("is_default") === "true";
                await store.mutate(async (client) => {
                    const found = await client.query<{ id: number }>("select id from providers where name = $1", [
                        providerName,
                    ]);
                    const providerId = found.rows[0]?.id;
                    if (providerId === undefined) throw new Error(`上游 ${providerName} 不存在`);
                    if (makeDefault) {
                        await client.query("update models set is_default = false where category = $1 and is_default", [
                            category,
                        ]);
                    }
                    await client.query(
                        `insert into models (provider_id, public_name, upstream_model, category, is_default)
                         values ($1, $2, $3, $4, $5)
                         on conflict (public_name) do update
                            set provider_id = excluded.provider_id,
                                upstream_model = excluded.upstream_model,
                                category = excluded.category,
                                is_default = excluded.is_default,
                                enabled = true`,
                        [providerId, publicName, upstreamModel, category, makeDefault],
                    );
                });
                redirect(response, "/admin/models?msg=" + encodeURIComponent(`模型 ${publicName} 已保存`));
                return true;
            }
            case "/admin/models/default": {
                const publicName = required(form, "public_name");
                await store.mutate(async (client) => {
                    const found = await client.query<{ category: string }>(
                        "select category from models where public_name = $1",
                        [publicName],
                    );
                    const category = found.rows[0]?.category;
                    if (category === undefined) throw new Error(`模型 ${publicName} 不存在`);
                    await client.query("update models set is_default = false where category = $1 and is_default", [category]);
                    await client.query("update models set is_default = true where public_name = $1", [publicName]);
                });
                redirect(response, "/admin/models?msg=" + encodeURIComponent(`${publicName} 已设为默认`));
                return true;
            }
            case "/admin/models/toggle": {
                const publicName = required(form, "public_name");
                const enabled = form.get("enabled") === "true";
                await store.mutate((client) =>
                    client.query("update models set enabled = $2 where public_name = $1", [publicName, enabled]),
                );
                redirect(response, "/admin/models?msg=" + encodeURIComponent(`${publicName} 已${enabled ? "启用" : "禁用"}`));
                return true;
            }
            case "/admin/services": {
                const name = required(form, "name");
                const key = generateServiceKey();
                await store.mutate(async (client) => {
                    await client.query(
                        `insert into services (name, key_hash, key_preview)
                         values ($1, $2, $3)
                         on conflict (name) do update
                            set key_hash = excluded.key_hash,
                                key_preview = excluded.key_preview,
                                enabled = true`,
                        [name, hashServiceKey(key), previewServiceKey(key)],
                    );
                });
                redirect(response, `/admin/services?created=${rememberKey(key)}`);
                return true;
            }
            case "/admin/services/toggle": {
                const name = required(form, "name");
                const enabled = form.get("enabled") === "true";
                await store.mutate((client) =>
                    client.query("update services set enabled = $2 where name = $1", [name, enabled]),
                );
                redirect(response, "/admin/services?msg=" + encodeURIComponent(`${name} 已${enabled ? "启用" : "禁用"}`));
                return true;
            }
            default:
                sendHtml(response, 404, layout({ title: "找不到页面", active: "none", body: "<h1>404</h1>" }));
                return true;
        }
    } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        redirect(response, url.pathname + "?level=error&msg=" + encodeURIComponent(text));
        return true;
    }
}

function required(form: URLSearchParams, name: string): string {
    const value = form.get(name)?.trim() ?? "";
    if (value === "") throw new Error(`缺少字段 ${name}`);
    return value;
}

async function readForm(request: IncomingMessage): Promise<URLSearchParams> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
        const buffer = chunk as Buffer;
        size += buffer.length;
        if (size > MAX_FORM_BYTES) throw new Error("表单过大");
        chunks.push(buffer);
    }
    return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

function sendHtml(response: ServerResponse, status: number, html: string): void {
    if (response.writableEnded || response.destroyed) return;
    response.writeHead(status, {
        "content-type": "text/html; charset=utf-8",
        "content-length": Buffer.byteLength(html),
        "x-frame-options": "DENY",
        "referrer-policy": "no-referrer",
    });
    response.end(html);
}

function redirect(response: ServerResponse, location: string): void {
    if (response.writableEnded || response.destroyed) return;
    response.writeHead(303, { location });
    response.end();
}
