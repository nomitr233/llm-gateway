# 接入文档（调用方）

这个网关对下游暴露的是 **OpenAI 兼容协议**：任何 OpenAI SDK 只需要改 `baseURL`、`apiKey`、`model` 三样。

- **base_url**：取决于你在哪里调用
  - 同一台服务器上的项目：`http://127.0.0.1:23360/v1`（端口只绑回环，别的机器连不上）
  - 本地开发：`http://127.0.0.1:4100/v1`
  - 跨机器/公网：`https://<域名>/v1`（经宿主 nginx）
- **api_key**：管理员给你签发的**服务 key**（`sk-gw-` 开头），每个项目一把，不共用
- **model**：填管理员登记过的**模型名**；不填则用该类别（文本/图片/语音）的默认模型

> 网关不保存对话、不缓存响应。每次请求都要把完整的 `messages` 带上来。

---

## 三分钟跑通

```bash
# 文本
curl http://127.0.0.1:23360/v1/chat/completions \
  -H "authorization: Bearer sk-gw-xxxx" \
  -H "content-type: application/json" \
  -d '{"messages":[{"role":"user","content":"你好"}]}'
```

用 OpenAI SDK：

```ts
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://127.0.0.1:23360/v1",   // 只改这一行
  apiKey: "sk-gw-xxxx",                    // 只改这一行
});

const reply = await client.chat.completions.create({
  model: "chat-default",     // 也可以不传，用文本类别的默认模型
  messages: [{ role: "user", content: "你好" }],
});
```

---

## 鉴权

```
Authorization: Bearer sk-gw-<服务 key>
```

| 情况 | 返回 |
|---|---|
| 没带 header / 格式不对 | `401 invalid_api_key` |
| key 不存在 | `401 invalid_api_key` |
| key 存在但服务被禁用 | `403 project_disabled` |

`/health` 不需要 key，`/v1/*` 全部需要。

---

## 端点总表

| 方法 | 路径 | 类别 | 说明 |
|---|---|---|---|
| POST | `/v1/chat/completions` | `text` | 对话，支持 SSE 流式 |
| POST | `/v1/images/generations` | `image` | 生图，统一返回 base64 |
| POST | `/v1/audio/speech` | `tts` | 文字转语音，返回二进制音频 |
| GET | `/v1/models` | — | 列出你能用的模型 |
| GET | `/health` | — | 存活探测（无需鉴权） |

`asr`（语音转文字）、`video`、`jev` 三个类别目前**没有端点**，管理员登记了也调不到。

---

## 1. POST /v1/chat/completions

### 请求

| 字段 | 必填 | 说明 |
|---|---|---|
| `model` | 否 | 登记的模型名；不传则用 `text` 类别的默认模型 |
| `messages` | 是 | OpenAI 标准格式，网关原样转发 |
| `stream` | 否 | `true` 时以 SSE 逐块返回 |
| 其它 | — | `temperature`、`max_tokens`、`tools` 等全部原样透传给上游 |

### 响应

非流式：上游的响应体**原样返回**（含 `usage`）。
流式：`text/event-stream`，每行 `data: {...}`，最后一行 `data: [DONE]`。

```bash
# 流式（curl 加 -N 关闭本地缓冲）
curl -N http://127.0.0.1:23360/v1/chat/completions \
  -H "authorization: Bearer sk-gw-xxxx" \
  -H "content-type: application/json" \
  -d '{"stream":true,"messages":[{"role":"user","content":"数到三"}]}'
```

```ts
const stream = await client.chat.completions.create({
  model: "chat-default",
  messages: [{ role: "user", content: "数到三" }],
  stream: true,
});
for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content ?? "");
}
```

### ⚠️ 推理模型的坑

如果登记的模型带思考过程（如 DeepSeek 的推理模型），响应里可能出现 `reasoning_content` 字段，而 `content` 是空的——因为思考过程先把 token 用完了。典型表现：

```json
"message": {
  "role": "assistant",
  "content": "",
  "reasoning_content": "We need answer user only ..."
},
"finish_reason": "length"
```

**只有 `finish_reason: "length"` 且 `content` 为空时**，才说明是被 `max_tokens` 截断了，不是网关坏了。给够 `max_tokens`，或者同时读 `reasoning_content`。

---

## 2. POST /v1/images/generations

### 请求

| 字段 | 必填 | 说明 |
|---|---|---|
| `model` | 否 | 不传则用 `image` 类别的默认模型 |
| `prompt` | **是** | 提示词，空字符串会 400 |
| `size` | 否 | 原样透传（如 `1024x1024`），是否支持取决于上游 |
| `n` | 否 | 1..4，超过报 400 |

### 响应

**统一返回 base64**，即使上游只给临时 url：

```json
{
  "created": 1793611577,
  "data": [
    { "b64_json": "iVBORw0KGgo...", "url": "https://上游临时地址", "revised_prompt": "..." }
  ]
}
```

- `b64_json`：一定有，直接 base64 解码就能得到图片字节
- `url`：上游给了就保留，方便排查；**不要依赖它长期有效**
- 单张图上限 10MB（超过会返回 502），`n=4` 时响应体可能 10MB+

```bash
curl -s http://127.0.0.1:23360/v1/images/generations \
  -H "authorization: Bearer sk-gw-xxxx" \
  -H "content-type: application/json" \
  -d '{"prompt":"一只橘猫坐在窗台上，水彩风格","n":1}' \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>require('fs').writeFileSync('cat.png',Buffer.from(JSON.parse(s).data[0].b64_json,'base64')))"
```

生成通常需要 **20–40 秒**，客户端的读超时不要设太短（建议 ≥ 120 秒）。

---

## 3. POST /v1/audio/speech

### 请求

| 字段 | 必填 | 说明 |
|---|---|---|
| `model` | 否 | 不传则用 `tts` 类别的默认模型 |
| `input` | **是** | 要合成的文字；也接受 `text` 作为别名 |
| `voice` | 否 | 不传默认 `alloy`；具体有哪些音色取决于上游 |
| `response_format` | 否 | 原样透传（`mp3`/`wav` 等，取决于上游） |

### 响应

**不是 JSON，是二进制音频**，`Content-Type` 由上游决定（常见 `audio/mpeg`），直接把响应体写成文件即可：

```bash
curl -s http://127.0.0.1:23360/v1/audio/speech \
  -H "authorization: Bearer sk-gw-xxxx" \
  -H "content-type: application/json" \
  -d '{"input":"你好，我是你的助手","voice":"alloy"}' \
  -o hello.mp3
```

不支持流式（`stream` 字段会被忽略，不会传给上游）。

---

## 4. GET /v1/models

需要鉴权。只返回你可用（已启用）的模型：

```json
{
  "object": "list",
  "data": [
    { "id": "deepseek-flash",      "object": "model", "owned_by": "deepseek", "category": "text",  "is_default": true  },
    { "id": "gpt-image-2.5-flare", "object": "model", "owned_by": "uuapi",    "category": "image", "is_default": true  }
  ]
}
```

- `id`：传给 `model` 字段的值
- `category`：`text` / `image` / `tts`（决定它能用在哪个端点）
- `is_default`：该类别不传 `model` 时用的就是它
- `owned_by`：上游名字，仅用于排查

---

## 5. GET /health

无需鉴权：

```json
{
  "ok": true,
  "snapshot": { "version": 3, "models": 4, "services": 2 },
  "database": { "up": true, "db": "llm_gateway_prod", "user": "llm_gateway_prod" }
}
```

数据库探活失败时 `ok` 仍是 `true`（代理链路不依赖数据库），但 `database.up` 会是 `false`。

---

## 错误码

所有错误都是 OpenAI 风格的同一个结构：

```json
{ "error": { "message": "人类可读的原因", "type": "invalid_request_error", "code": "unknown_model" } }
```

| HTTP | code | 含义 | 调用方该怎么做 |
|---|---|---|---|
| 400 | `bad_request` | 请求体不是 JSON、缺字段（如 `prompt`/`input`）、`n` 越界、超过 10MB | 修请求 |
| 400 | `unknown_model` | `model` 没登记 | 用 `/v1/models` 里有的 |
| 400 | `model_category_mismatch` | 模型类别和端点不匹配（拿图片模型打对话接口） | 换模型或换端点 |
| 400 | `no_default_model` | 没传 `model`，而该类别没设默认模型 | 显式传 `model` |
| 401 | `invalid_api_key` | key 缺失/无效 | 检查 key |
| 403 | `project_disabled` | 服务被管理员禁用 | 联系管理员 |
| 404 | `not_found` | 路径不存在 | 检查 URL |
| 429 | `quota_exceeded` | 额度超限（**当前未启用**，限额功能未实现） | — |
| 4xx | `upstream_error` | 上游拒绝了请求，状态码原样透传 | 看 `message` 里的状态码 |
| 502 | `bad_gateway` | 上游不可达 / 返回 5xx / 图片超限 | 可重试 |
| 504 | `upstream_timeout` | 上游超时 | 可重试 |

上游 4xx **不会重试**（重试只会白烧配额）；5xx 和超时会按网关配置自动重试若干次，之后才返回上面的错误。

出于安全，上游的响应体**不会**透给你，只会告诉你状态码和错误类型。

---

## 行为约定

- **无状态**：网关不保存对话历史、不做会话，也不缓存响应。
- **模型名会被替换**：你传的登记名会在发往上游时换成真实模型名，所以你的请求里不要依赖模型名被原样传给上游。
- **请求体上限 10MB**；图片单张上限 10MB。
- **超时**：每个上游有独立超时（管理员配置，常见 120–300 秒），生图和长文本注意把客户端读超时调大。
- **并发**：网关是单进程异步的，请求之间不共享状态；生图这类重请求会占用内存（一张图 3MB 左右），批量并发请自行控制。

---

## 新项目接入清单

1. 找管理员要一把**服务 key**（`sk-gw-` 开头），一个项目一把，别和别的项目共用
2. 调 `GET /v1/models` 看你能用哪些模型、哪个是默认
3. 把 SDK 的 `baseURL` 改成网关地址，`apiKey` 换成服务 key
4. 先发一条文本请求验证连通，再逐个接图片/语音
5. 客户端超时按端点设：文本 120s、生图 300s

---

## 变更记录

| 版本 | 内容 |
|---|---|
| v1 | `/v1/chat/completions`（含 stream）、`/v1/images/generations`、`/v1/audio/speech`、`/v1/models`、`/health` |
