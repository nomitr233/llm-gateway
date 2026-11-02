import { escapeHtml, layout, notice } from "./html.ts";

export type ProviderRow = { name: string; base_url: string; timeout_ms: number; enabled: boolean };
export type ModelRow = {
    public_name: string;
    category: string;
    upstream_model: string;
    provider: string;
    is_default: boolean;
    enabled: boolean;
};
export type ServiceRow = { name: string; key_preview: string; enabled: boolean };

function statusTag(enabled: boolean): string {
    return enabled ? '<span class="tag on">启用</span>' : '<span class="tag off">禁用</span>';
}

function flash(message: string | undefined, kind: "ok" | "warn" | "error" = "ok"): string {
    return message === undefined || message === "" ? "" : notice(message, kind);
}

export function dashboardPage(input: {
    providers: number;
    models: number;
    services: number;
    defaults: { category: string; publicName: string }[];
    snapshotVersion: number;
    message?: string;
}): string {
    const defaults =
        input.defaults.length === 0
            ? '<p class="muted">还没有设置任何默认模型。下游不带 model 调用会返回 <code>no_default_model</code>。</p>'
            : `<table><tr><th>类别</th><th>默认模型</th></tr>${input.defaults
                  .map(
                      (item) =>
                          `<tr><td><span class="tag">${escapeHtml(item.category)}</span></td><td class="mono">${escapeHtml(
                              item.publicName,
                          )}</td></tr>`,
                  )
                  .join("")}</table>`;

    return layout({
        title: "概览",
        active: "overview",
        body: `<h1>概览</h1>
${flash(input.message)}
<div class="grid">
  <div class="card"><div class="muted">上游</div><div class="metric">${input.providers}</div></div>
  <div class="card"><div class="muted">模型</div><div class="metric">${input.models}</div></div>
  <div class="card"><div class="muted">服务 key</div><div class="metric">${input.services}</div></div>
  <div class="card"><div class="muted">快照版本</div><div class="metric">${input.snapshotVersion}</div></div>
</div>
<h2>默认模型</h2>
${defaults}
<h2>说明</h2>
<p class="muted">下游调用 <code>http://127.0.0.1:4100/v1</code>，带服务 key，
model 填这里登记的模型名；不填则用对应类别的默认模型。改完立即生效，无需重启。</p>`,
    });
}

export function providersPage(rows: ProviderRow[], message?: string): string {
    const table =
        rows.length === 0
            ? '<p class="muted">还没有上游。先在上面加一个。</p>'
            : `<table>
<tr><th>名字</th><th>地址</th><th>超时</th><th>状态</th><th></th></tr>
${rows
    .map(
        (row) => `<tr>
  <td class="mono">${escapeHtml(row.name)}</td>
  <td class="mono muted">${escapeHtml(row.base_url)}</td>
  <td>${row.timeout_ms}ms</td>
  <td>${statusTag(row.enabled)}</td>
  <td><form method="post" action="/admin/providers/toggle">
    <input type="hidden" name="name" value="${escapeHtml(row.name)}">
    <input type="hidden" name="enabled" value="${row.enabled ? "false" : "true"}">
    <button class="ghost" type="submit">${row.enabled ? "禁用" : "启用"}</button>
  </form></td>
</tr>`,
    )
    .join("")}
</table>`;

    return layout({
        title: "上游",
        active: "providers",
        body: `<h1>上游 provider</h1>
${flash(message)}
<h2>新增 / 更新</h2>
<form method="post" action="/admin/providers">
  <label>名字<input name="name" required placeholder="deepseek"></label>
  <label>Base URL<input name="base_url" required size="34" placeholder="https://api.deepseek.com/v1"></label>
  <label>API key<input name="api_key" required placeholder="sk-...（只写不回显）"></label>
  <label>超时(ms)<input name="timeout_ms" value="120000" size="8"></label>
  <button type="submit">保存</button>
</form>
<p class="muted">key 会用 <code>GATEWAY_SECRET</code> 加密后存库，页面上永远不回显；重复提交同名上游等于替换它的 key。</p>
<h2>已登记</h2>
${table}`,
    });
}

export function modelsPage(rows: ModelRow[], providers: string[], message?: string): string {
    const table =
        rows.length === 0
            ? '<p class="muted">还没有模型。</p>'
            : `<table>
<tr><th>下游模型名</th><th>类别</th><th>上游</th><th>真实模型</th><th>默认</th><th>状态</th><th></th></tr>
${rows
    .map(
        (row) => `<tr>
  <td class="mono">${escapeHtml(row.public_name)}</td>
  <td><span class="tag">${escapeHtml(row.category)}</span></td>
  <td class="mono muted">${escapeHtml(row.provider)}</td>
  <td class="mono muted">${escapeHtml(row.upstream_model)}</td>
  <td>${row.is_default ? '<span class="tag on">默认</span>' : ""}</td>
  <td>${statusTag(row.enabled)}</td>
  <td>
    <form method="post" action="/admin/models/default" style="display:inline">
      <input type="hidden" name="public_name" value="${escapeHtml(row.public_name)}">
      <button class="ghost" type="submit"${row.is_default ? " disabled" : ""}>设为默认</button>
    </form>
    <form method="post" action="/admin/models/toggle" style="display:inline">
      <input type="hidden" name="public_name" value="${escapeHtml(row.public_name)}">
      <input type="hidden" name="enabled" value="${row.enabled ? "false" : "true"}">
      <button class="ghost" type="submit">${row.enabled ? "禁用" : "启用"}</button>
    </form>
  </td>
</tr>`,
    )
    .join("")}
</table>`;

    const providerOptions =
        providers.length === 0
            ? '<option value="">（先加一个上游）</option>'
            : providers.map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join("");

    return layout({
        title: "模型",
        active: "models",
        body: `<h1>模型</h1>
${flash(message)}
<h2>新增 / 更新</h2>
<form method="post" action="/admin/models">
  <label>下游模型名<input name="public_name" required placeholder="chat-default"></label>
  <label>上游<select name="provider" required>${providerOptions}</select></label>
  <label>真实模型名<input name="upstream_model" required placeholder="deepseek-chat"></label>
  <label>类别<select name="category">
    <option value="text">text</option>
    <option value="image">image</option>
    <option value="tts">tts（文字转语音）</option>
    <option value="asr">asr（语音转文字）</option>
    <option value="video">video</option>
    <option value="jev">jev</option>
  </select></label>
  <label>默认<input type="checkbox" name="is_default" value="true"></label>
  <button type="submit">保存</button>
</form>
<p class="muted">每个类别最多一个默认模型；勾了默认会自动取消同类别的旧默认。</p>
<h2>已登记</h2>
${table}`,
    });
}

export function servicesPage(rows: ServiceRow[], createdKey?: string, message?: string): string {
    const table =
        rows.length === 0
            ? '<p class="muted">还没有服务 key。</p>'
            : `<table>
<tr><th>服务</th><th>key</th><th>状态</th><th></th></tr>
${rows
    .map(
        (row) => `<tr>
  <td class="mono">${escapeHtml(row.name)}</td>
  <td class="mono muted">${escapeHtml(row.key_preview)}</td>
  <td>${statusTag(row.enabled)}</td>
  <td><form method="post" action="/admin/services/toggle">
    <input type="hidden" name="name" value="${escapeHtml(row.name)}">
    <input type="hidden" name="enabled" value="${row.enabled ? "false" : "true"}">
    <button class="ghost" type="submit">${row.enabled ? "禁用" : "启用"}</button>
  </form></td>
</tr>`,
    )
    .join("")}
</table>`;

    const created =
        createdKey === undefined
            ? ""
            : `<h2>新 key（只显示这一次）</h2>
<div class="keybox">${escapeHtml(createdKey)}</div>
<p class="muted">现在复制走。之后再想看只能重新生成，重新生成会让旧 key 立刻失效。</p>`;

    return layout({
        title: "服务 key",
        active: "services",
        body: `<h1>服务 key</h1>
${flash(message)}
${created}
<h2>新增 / 重置</h2>
<form method="post" action="/admin/services">
  <label>服务名<input name="name" required placeholder="qqbot"></label>
  <button type="submit">生成 key</button>
</form>
<p class="muted">同名服务重新生成会覆盖旧 key（旧 key 立刻失效）。库里只存 SHA-256 哈希。</p>
<h2>已登记</h2>
${table}`,
    });
}
