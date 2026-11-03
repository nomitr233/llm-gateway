# 部署说明

本项目遵循服务器的《网络分段与项目接入规范》，形态是**容器化 + 宿主 nginx**，不使用 pm2。

```
调用方 ──https──> 宿主 nginx :443 ──反代──> 127.0.0.1:23360 ──> llm-gateway_backend:4100
                                                                      │
                                                          容器名 postgres:5432
                                                        （双归属 nomitr_net）
```

## 决策记录

| 项 | 决定 |
|---|---|
| 运行时 | 容器（`restart: unless-stopped`），无 pm2 |
| 目录 | `/home/ubuntu/dockers/projects/llm-gateway/` |
| 宿主端口 | **23360**，且只绑 `127.0.0.1`；容器内仍是 4100 |
| 网络 | 项目网段 `llm-gateway_net`（显式 name）；`backend` 双归属 `nomitr_net` |
| 数据库寻址 | `postgres:5432`（容器名 + 内网端口），不写公网 IP:端口 |
| 数据库账号 | 专用角色 `llm_gateway`，不复用超管 `nomitr` |
| 对外暴露 | 只经宿主 nginx；容器不发布公网端口 |

## 需要登记到 DEPLOYMENT.md 的内容

- **§3 端口表**：`23360` → `llm-gateway_backend`（宿主回环）
- **§4 容器清单**：`llm-gateway_backend`（`restart: unless-stopped`）
- **§5 网络与数据卷**：`llm-gateway_net` 成员 `llm-gateway_backend`；无数据卷（无状态）

## 首次部署

服务器上（`ubuntu` 用户，需在 docker 组）：

```bash
mkdir -p /home/ubuntu/dockers/projects/llm-gateway
cd /home/ubuntu/dockers/projects/llm-gateway
git clone https://github.com/nomitr233/llm-gateway.git .

cp .env.prod.template .env.prod
chmod 600 .env.prod
# 填 .env.prod：DATABASE_URL / GATEWAY_SECRET / ADMIN_PASSWORD / ADMIN_ALLOWED_IPS

docker compose -f docker-compose.prod.yml up -d --build
curl -fsS http://127.0.0.1:23360/health
```

### 数据库账号

在中间件容器里用 `nomitr` 创建（Postgres 的超级用户角色是 `nomitr`，**不是** `postgres`）：

```sql
CREATE ROLE llm_gateway LOGIN PASSWORD '<强密码>';
-- 已存在的库：转移所有权，表才不会因权限不足而建不了/改不了
ALTER DATABASE llm_gateway OWNER TO llm_gateway;
\c llm_gateway
REASSIGN OWNED BY nomitr TO llm_gateway;
GRANT ALL ON SCHEMA public TO llm_gateway;
```

然后 `.env.prod` 里的 `DATABASE_URL` 用新角色：

```
postgresql://llm_gateway:<强密码>@postgres:5432/llm_gateway
```

表结构由网关启动时自动迁移（`applySchema`），不需要额外执行 SQL，也没有 `psql`/`pg_dump` 依赖。

### 在容器里登记配置

镜像里带了 `scripts/admin.ts`，环境变量由 compose 注入，所以可以直接在容器里跑：

```bash
docker exec -it llm-gateway_backend node scripts/admin.ts provider add \
  --name deepseek --base-url https://api.deepseek.com --api-key sk-xxxx
docker exec -it llm-gateway_backend node scripts/admin.ts model add \
  --public chat-default --provider deepseek --upstream deepseek-chat --category text --default
docker exec -it llm-gateway_backend node scripts/admin.ts service add --name qqbot   # 只打印一次
docker exec -it llm-gateway_backend node scripts/admin.ts provider list
```

面板（SSH 隧道后）也能做同样的事，CLI 适合脚本化和首次初始化。

## 环境变量

| 变量 | 说明 |
|---|---|
| `HOST` | 容器内必须是 `0.0.0.0`，否则宿主发布的端口进不来 |
| `GATEWAY_SECRET` | **必须与库中现有密文一致**。改了它，所有 provider key 都会解密失败、网关拒绝启动 |
| `ADMIN_PASSWORD` | 面板密码，≥ 8 位 |
| `ADMIN_ALLOWED_IPS` | 面板来源白名单，见下 |

## 管理面板

面板不能走反代：`src/admin/router.ts` 靠来源地址判断是否放行，一旦经过 nginx，所有请求看起来都来自同一处，白名单就失去意义。因此：

1. nginx 里 `/admin` 直接 `return 404`；
2. 容器里的请求 `remoteAddress` 是**网桥网关 IP**，所以 `.env.prod` 要把这一台显式加进白名单：

```bash
docker exec llm-gateway_backend ip route | grep default
# default via 172.18.0.1 dev eth0   ← 把 172.18.0.1 填进 ADMIN_ALLOWED_IPS
```

```env
ADMIN_ALLOWED_IPS=127.0.0.1,::1,172.18.0.1
```

3. 访问走 SSH 隧道：

```bash
ssh -L 23360:127.0.0.1:23360 ubuntu@82.157.67.181
# 浏览器打开 http://127.0.0.1:23360/admin
```

## 宿主 nginx

```nginx
server {
    listen 80;
    server_name gw.example.com;
    location /.well-known/acme-challenge/ { root /var/www/html; }
    location / { return 301 https://$host$request_uri; }
}

server {
    listen 443 ssl;
    server_name gw.example.com;

    ssl_certificate     /etc/letsencrypt/live/gw.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/gw.example.com/privkey.pem;

    client_max_body_size 10m;        # 与网关请求体上限对齐

    # 面板一律不可从公网到达
    location /admin { return 404; }

    location /v1/ {
        proxy_pass http://127.0.0.1:23360;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_buffering off;         # SSE 必须关，否则流式会被攒住
        proxy_read_timeout 300s;     # 生图 30s+，长文流式更久
    }

    location /health {
        proxy_pass http://127.0.0.1:23360;
    }
}
```

## CI / CD

- `ci.yml`：push / PR 跑 `pnpm install --frozen-lockfile` + `pnpm check`（typecheck + 全部单测），不需要任何 Secret
- `deploy.yml`：`ci` 对 main 成功之后，SSH 到服务器执行 `scripts/deploy.sh`
- `scripts/deploy.sh`：`git reset --hard origin/main` → `docker compose up -d --build` → 轮询 `/health` → 失败自动回滚到上一个 commit 并重建

需要的 GitHub 配置：

| 类型 | 名字 | 值 |
|---|---|---|
| Secret | `SSH_HOST` | 服务器地址 |
| Secret | `SSH_USER` | `ubuntu` |
| Secret | `SSH_PRIVATE_KEY` | 专为部署生成的私钥全文 |
| Variable | `SSH_PORT` | `22`（可选） |

`.env.prod` 不经过 CI：它只存在于服务器上（600 权限），CI 不接触任何密钥。

## 回滚

```bash
cd /home/ubuntu/dockers/projects/llm-gateway
git log --oneline -5
git reset --hard <上一个 commit>
docker compose -f docker-compose.prod.yml up -d --build
```

`deploy.sh` 在健康检查失败时会自动做这一套。

## 验证清单

```bash
docker network inspect nomitr_net | grep -A2 llm-gateway_backend   # 双归属
docker exec llm-gateway_backend getent hosts postgres               # DNS 解析成功
docker exec llm-gateway_backend nc -zv postgres 5432                # 端口可达
ss -tlnp | grep 23360                                               # 应为 127.0.0.1:23360
curl -fsS https://gw.example.com/health                             # 200
curl -s -o /dev/null -w '%{http_code}\n' https://gw.example.com/admin  # 404
```
