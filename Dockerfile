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
# 注意：不要写 --platform=$TARGETPLATFORM —— buildx 提示冗余，且 legacy builder
# （docker build，服务器侧直接构建用）解析不了这个变量，会直接报错。
FROM public.ecr.aws/docker/library/node:20-bookworm AS deps

# 🔴 2026-11-22 事故记录：不要给 better-sqlite3 设 npmmirror binary host！
#   npmmirror/-/binary/better-sqlite3 的 v13.0.3 预编译产物是坏的——
#   dlopen 成功、:memory: 正常，但**文件型 DB（WAL）一打开就 SIGSEGV（exit 139）**。
#   实测对照：同版本走 GitHub 官方 prebuilt 完全正常（服务器 node:20/22 双验证）。
#   该坏产物曾同时烤进本机 QEMU 构建与服务器本地构建的镜像，容器无限崩溃重启。
#   现恢复 prebuild-install 默认源（GitHub releases），服务器实测可正常下载；
#   npm 包本身仍走 npmmirror registry（无影响）。

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund --registry=https://registry.npmmirror.com \
 && npm cache clean --force

# ⚠️ 2026-11-21 记录：不要在这里加「容器内跑 better-sqlite3」的构建期自检。
# 开发机（Apple Silicon + Docker Desktop）的容器运行时跑不了 better-sqlite3——
# 实测裸 node:20-bookworm 现装 13.0.3 也 SIGSEGV（exit 139），与安装路径无关；
# 而同一个镜像在线上 amd64 服务器跑得好好（healthz 通、订单在库）。
# 也就是说本地「跑不了」不代表镜像坏，自检只会造成误报、挡住发布。
# 真正的防线在部署后：deploy.sh 的重启健康检查（/healthz 轮询 30s）
# + 部署后对公网地址跑 scripts/verify.sh 全量回归。

# ── 阶段 2：运行时 ──────────────────────────────────────────
FROM public.ecr.aws/docker/library/node:20-bookworm AS runtime

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
