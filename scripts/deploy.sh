#!/usr/bin/env bash
# 服务器端幂等部署脚本：拉最新代码 → 重建镜像 → 起容器 → 健康检查 → 失败自动回滚
# 由 GitHub Actions 通过 SSH 调用，也可以手动跑。
set -euo pipefail

APP_DIR="${APP_DIR:-/home/ubuntu/dockers/projects/llm-gateway}"
BRANCH="${BRANCH:-main}"
COMPOSE_FILE="docker-compose.prod.yml"
HEALTH_URL="http://127.0.0.1:23360/health"
HEALTH_RETRIES=30
HEALTH_INTERVAL=2

log() { printf '[deploy] %s\n' "$*"; }

cd "$APP_DIR"

if [[ ! -f .env.prod ]]; then
  echo "[deploy] 缺少 $APP_DIR/.env.prod —— 先从 .env.prod.template 复制并填值" >&2
  exit 1
fi

if [[ ! -f "$COMPOSE_FILE" ]]; then
  echo "[deploy] 缺少 $APP_DIR/$COMPOSE_FILE" >&2
  exit 1
fi

PREV_COMMIT="$(git rev-parse HEAD)"
log "当前 commit ${PREV_COMMIT:0:7}"

log "拉取 origin/$BRANCH"
git fetch --prune origin "$BRANCH"
git reset --hard "origin/$BRANCH"
NEW_COMMIT="$(git rev-parse HEAD)"
log "更新到 commit ${NEW_COMMIT:0:7}"

log "重建并启动容器"
docker compose -f "$COMPOSE_FILE" up -d --build

log "等待健康检查"
for ((i = 1; i <= HEALTH_RETRIES; i++)); do
  if curl -fsS -m 3 "$HEALTH_URL" >/dev/null 2>&1; then
    log "第 ${i} 次探测通过"
    docker compose -f "$COMPOSE_FILE" ps
    exit 0
  fi
  sleep "$HEALTH_INTERVAL"
done

echo "[deploy] 健康检查失败，回滚到 ${PREV_COMMIT:0:7}" >&2
docker compose -f "$COMPOSE_FILE" logs --tail=120 backend >&2 || true
git reset --hard "$PREV_COMMIT"
docker compose -f "$COMPOSE_FILE" up -d --build
echo "[deploy] 已回滚，请查看上面的日志" >&2
exit 1
