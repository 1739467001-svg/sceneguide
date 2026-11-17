# ============================================================
# 三维问路 · SceneGuide —— 生产镜像（PAYATHON 2026）
#
# 关键设计（针对 2G / 可用内存约 300MB 的云服务器）：
#   1. 依赖在**构建期**安装并烤进镜像 —— 容器启动不再跑 npm ci。
#      ��是本项目上云的关键：npm ci 瞬时吃 300–500MB，
#      在可用内存 300MB 的机器上必然 OOM。
#   2. 场景数据烤进 /app/scenes，与数据库卷 /app/data 物理分离，
#      杜绝「卷挂载遮蔽内置数据」这类事故（历史上踩过）。
#   3. Node 堆上限 128MB，容器内存上限 256MB，给宿主留足余量。
#   4. 非 root 运行；HEALTHCHECK 内置。
#
# 构建（Apple Silicon 上交叉构建 amd64）：
#   docker buildx build --platform linux/amd64 -t sceneguide:1.0 --load .
#   docker save sceneguide:1.0 | gzip > sceneguide-1.0.tar.gz
# 服务器侧：
#   gunzip -c sceneguide-1.0.tar.gz | docker load
# ============================================================

# ── 阶段 1：依赖 ────────────────────────────────────────────
FROM --platform=$TARGETPLATFORM public.ecr.aws/docker/library/node:20-bookworm AS deps

# better-sqlite3 走预编译二进制（避免容器内编译，吃内存也吃时间）
ENV npm_config_better_sqlite3_binary_host=https://registry.npmmirror.com/-/binary/better-sqlite3 \
    npm_config_better_sqlite3_binary_host_mirror=https://npmmirror.com/mirrors/better-sqlite3/

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund --registry=https://registry.npmmirror.com \
 && npm cache clean --force

# ── 阶段 2：运行时 ──────────────────────────────────────────
FROM --platform=$TARGETPLATFORM public.ecr.aws/docker/library/node:20-bookworm AS runtime

ENV NODE_ENV=production \
    PORT=3000 \
    NODE_OPTIONS=--max-old-space-size=128 \
    SCENE_DIR=/app/scenes \
    ANALYTICS_DB=/app/data/analytics.db \
    npm_config_update_notifier=false

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts
COPY config ./config
COPY SKILL.md README.md ./
# 场景数据烤进镜像（与 /app/data 数据库卷分离）
COPY data/scenes ./scenes

# 预建数据目录（compose 会把宿主 ./data 挂到这里，只放数据库）
RUN mkdir -p /app/data && chown -R node:node /app

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
