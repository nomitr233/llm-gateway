FROM node:24-alpine

# 项目直接跑 TypeScript（无构建步骤），所以只需要运行期依赖
RUN npm install -g pnpm@12.6.0

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile

COPY --chown=node:node src ./src
# 管理 CLI 也进镜像，方便在容器里直接登记上游/模型/服务 key
COPY --chown=node:node scripts ./scripts

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4100

USER node
EXPOSE 4100

# 容器内自检：/health 里有数据库探活，返回非 2xx 就判定不健康
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:4100/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "src/index.ts"]
