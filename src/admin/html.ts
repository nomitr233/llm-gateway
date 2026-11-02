const ESCAPES: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
};

/** 所有进模板的值都必须过这一层，别直接拼字符串 */
export function escapeHtml(value: unknown): string {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ESCAPES[char] ?? char);
}

const STYLES = `
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body { margin: 0; font: 14px/1.6 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
       background: #0f1115; color: #e6e8ee; }
header { display: flex; gap: 24px; align-items: center; padding: 14px 24px;
         border-bottom: 1px solid #232734; background: #12151c; }
header strong { font-weight: 600; letter-spacing: .3px; }
nav { display: flex; gap: 16px; }
nav a { color: #9aa3b5; text-decoration: none; padding: 4px 0; border-bottom: 2px solid transparent; }
nav a:hover { color: #e6e8ee; }
nav a.active { color: #7cc4ff; border-bottom-color: #7cc4ff; }
main { padding: 24px; max-width: 1100px; }
h1 { font-size: 18px; margin: 0 0 16px; font-weight: 600; }
h2 { font-size: 14px; margin: 28px 0 10px; color: #9aa3b5; font-weight: 600;
     text-transform: uppercase; letter-spacing: .8px; }
table { width: 100%; border-collapse: collapse; background: #12151c;
        border: 1px solid #232734; border-radius: 8px; overflow: hidden; }
th, td { text-align: left; padding: 9px 12px; border-bottom: 1px solid #1c2030; font-size: 13px; }
th { background: #151924; color: #9aa3b5; font-weight: 500; }
tr:last-child td { border-bottom: none; }
code, .mono { font-family: ui-monospace, Consolas, monospace; font-size: 12px; }
.card { background: #12151c; border: 1px solid #232734; border-radius: 8px; padding: 16px; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; }
.metric { font-size: 22px; font-weight: 600; }
.muted { color: #7c8398; }
.tag { display: inline-block; padding: 1px 8px; border-radius: 999px;
       background: #1c2333; color: #9aa3b5; font-size: 11px; }
.tag.on { background: #14301f; color: #6ee7a0; }
.tag.off { background: #341a1a; color: #f09a9a; }
form { display: flex; flex-wrap: wrap; gap: 10px; align-items: flex-end; }
label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: #9aa3b5; }
input, select { background: #0b0e14; border: 1px solid #2a2f40; color: #e6e8ee;
                border-radius: 6px; padding: 7px 9px; font: inherit; min-width: 150px; }
input[type=checkbox] { min-width: auto; }
button { background: #1d64d8; color: #fff; border: none; border-radius: 6px;
         padding: 8px 14px; font: inherit; cursor: pointer; }
button.ghost { background: transparent; border: 1px solid #2a2f40; color: #c9d0de; }
button.danger { background: transparent; border: 1px solid #4a2020; color: #f09a9a; }
.notice { background: #14301f; border: 1px solid #1f4d33; color: #8ef0b4;
          padding: 10px 12px; border-radius: 8px; margin-bottom: 16px; }
.notice.warn { background: #33270f; border-color: #5a4315; color: #f2c97d; }
.notice.error { background: #331818; border-color: #5a2323; color: #f09a9a; }
.keybox { font-family: ui-monospace, Consolas, monospace; font-size: 13px;
          background: #0b0e14; border: 1px dashed #2a2f40; padding: 12px;
          border-radius: 8px; word-break: break-all; }
.login { max-width: 320px; margin: 12vh auto; }
.login form { flex-direction: column; align-items: stretch; }
`;

export interface LayoutOptions {
    title: string;
    active: string;
    body: string;
}

export function layout(options: LayoutOptions): string {
    const links = [
        { href: "/admin", label: "概览", key: "overview" },
        { href: "/admin/providers", label: "上游", key: "providers" },
        { href: "/admin/models", label: "模型", key: "models" },
        { href: "/admin/services", label: "服务 key", key: "services" },
    ];
    const nav = links
        .map((link) => `<a href="${link.href}"${link.key === options.active ? ' class="active"' : ""}>${link.label}</a>`)
        .join("");
    return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(options.title)} · LLM Gateway</title>
<style>${STYLES}</style>
</head>
<body>
<header><strong>LLM Gateway</strong><nav>${nav}</nav></header>
<main>${options.body}</main>
</body>
</html>`;
}

export function loginPage(errorMessage?: string): string {
    const notice = errorMessage === undefined ? "" : `<div class="notice error">${escapeHtml(errorMessage)}</div>`;
    return layout({
        title: "登录",
        active: "none",
        body: `<div class="login card">
  <h1>管理面板</h1>
  ${notice}
  <form method="post" action="/admin/login">
    <label>密码<input type="password" name="password" autofocus required></label>
    <button type="submit">登录</button>
  </form>
</div>`,
    });
}

export function notice(message: string, kind: "ok" | "warn" | "error" = "ok"): string {
    const className = kind === "ok" ? "notice" : `notice ${kind}`;
    return `<div class="${className}">${escapeHtml(message)}</div>`;
}
