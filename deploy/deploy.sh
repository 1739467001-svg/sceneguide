#!/usr/bin/env bash
# ============================================================
# SceneGuide 一键发布
#
#   TARGET=aliyun bash deploy/deploy.sh     # 生产（121.43.80.231）
#   TARGET=sg60   bash deploy/deploy.sh    # 60.205.204.162
#   SERVER=user@host bash deploy/deploy.sh # 其它机器（systemd 裸机路径）
#
# Compose 路径的流程（2026-11-22 改版）：
#   代码包 tar 上传 → 解压进 ${APP_DIR}/app（compose ./app:/app 挂载的正是它）
#   → 场景数据同步到 ${APP_DIR}/scenes → compose up -d --force-recreate → 健康检查
#
# 🔴 为什么改为「运行时 npm ci」而不是本地构建镜像：
#    本机 QEMU 交叉构建与服务器本地构建的 node:20 镜像里，better-sqlite3
#    对文件型 DB 均 SIGSEGV（exit 139），复现条件未分离（详见服务器部署清单）；
#    而 node:22 + 启动时 npm ci（deps 卷缓存）是本机数周验证的稳定栈。
#    deps 卷首次冷启动 npm ci 约 1-3 分钟，健康检查 start_period 已放宽。
# ============================================================
set -euo pipefail

# 目标一（Compose：aliyun 生产 / sg60 备用）
# 目标二（systemd 裸机，其它机器）：SERVER=user@<ip>

TARGET="${1:-${TARGET:-}}"

# 目标映射：aliyun = 当前生产（121.43.80.231）；sg60 = 60.205.204.162
CASE_HOST() {
  case "$1" in
    aliyun) echo "aliyun" ;;              # ssh config 别名 → 121.43.80.231
    sg60)   echo "root@60.205.204.162" ;;
    *)      echo "$1" ;;                  # 直接给 user@host
  esac
}
if [[ "$TARGET" == "sg60" || "$TARGET" == "aliyun" ]]; then
  set -euo pipefail
  HOST="$(CASE_HOST "$TARGET")"
  if [[ "$HOST" == "root@60.205.204.162" ]]; then
    ssh -o ConnectTimeout=8 -o BatchMode=yes "$HOST" 'echo ok' >/dev/null 2>&1 \
      || { echo "✗ 60.205.204.162 不可达（安全组未放行 22/80？或死机）。可改投 aliyun：TARGET=aliyun"; exit 1; }
  fi
  APP_DIR="/srv/apps/sceneguide"
  PORT=3001
  echo "▸ 发布到 ${HOST}：${APP_DIR}（Docker Compose · node:22 运行时 npm ci 栈 · 回环端口 ${PORT}）"

  # ── 2026-11-22 流程改版：不再本地构建/上传镜像 ──────────────
  # 原因（一次完整事故复盘，见 deploy/服务器部署清单.md「四个部署坑」）：
  #   ① compose 文件根本没用 sceneguide:1.0 镜像（image 写的是 node:22 裸基镜像），
  #      本地辛苦构建上传的镜像全程被无视；
  #   ② 镜像里 better-sqlite3（node:20 deps）在本服务器上文件型 DB 必 SIGSEGV——
  #      本机 QEMU 交叉构建与服务器本地构建均复现，同字节二进制在全新容器却正常，
  #      复现条件未分离（记录在案，待查）；node:22 + 运行时 npm ci 是本机历史稳定栈。
  # 新流程：代码包 tar → 解压进 ${APP_DIR}/app（compose ./app:/app 挂载的正是它，
  #   含沙箱密钥权威副本）→ 场景数据同步 → compose up -d --force-recreate → 健康检查。
  # npm ci 在容器启动时执行（deps 卷缓存，峰值内存实测 < 400MB，2G 机可承受）。

  # ── 1. 代码包上传 ──────────────────────────────────────
  # 密钥与运行数据永不上传（服务器侧已有权威副本）；
  # data/scenes/*.json 是构建产物（纯 OSM 衍生数据、无密钥无用户数据），必须随包发布
  echo "▸ 上传代码包 → 解压进 ${APP_DIR}/app（容器经 ./app:/app 挂载读取）"
  tar -czf /tmp/sg-src.tar.gz --exclude 'node_modules' --exclude 'data/*.db*' \
    --exclude 'data/analytics*' --exclude 'data/orders*' \
    --exclude '.alipay-sandbox.json' --exclude 'config/production.json' \
    --exclude '.git' --exclude '*.log' \
    -C "$(pwd)" public src scripts config SKILL.md package.json package-lock.json README.md data/scenes
  scp -q /tmp/sg-src.tar.gz "$HOST:/tmp/"
  ssh "$HOST" "cd ${APP_DIR} && mkdir -p app && tar -xzf /tmp/sg-src.tar.gz -C app && rm /tmp/sg-src.tar.gz"
  rm -f /tmp/sg-src.tar.gz

  # 🔴 场景数据落到 compose 的 ro 挂载点：SCENE_DIR=/app/scenes → 宿主 ${APP_DIR}/scenes
  echo "▸ 同步场景数据到 ${APP_DIR}/scenes"
  ssh "$HOST" "mkdir -p ${APP_DIR}/scenes && cp -f ${APP_DIR}/app/data/scenes/*.json ${APP_DIR}/scenes/"

  # ── 4. 重建容器（--force-recreate；npm ci 在启动时执行，需给足 start_period）──
  echo "▸ 重建容器（compose up -d --force-recreate）"
  ssh "$HOST" "cd ${APP_DIR} && docker compose up -d --force-recreate"

  # ── 5. 健康检查（npm ci 启动需 1-3 分钟，重试最多 5 分钟）──
  echo "▸ 健康检查（最多 5 分钟，npm ci 冷启动较慢）"
  OK=""
  for i in $(seq 1 30); do
    sleep 10
    if ssh "$HOST" "curl -sf http://127.0.0.1:${PORT}/healthz" >/dev/null; then OK=1; break; fi
  done
  if [[ -n "$OK" ]]; then
    echo "✓ 发布成功"
    echo "  公网验收：BASE_URL=https://121.43.80.231/sceneguide bash scripts/verify.sh（92 项）"
    echo "  回滚：ssh ${HOST} 'cd ${APP_DIR} && cp app/app.bak-<date>.tar.gz app/ && docker compose up -d --force-recreate'"

    # ── 5.5 环境闸门：切生产后自检（沙箱部署则只提示不阻塞）──
    #    prod-check 会核对：生产配置齐全 / 私钥是 PKCS#1 / sellerId 与报名账号一致 /
    #    四档 serviceId 都是真实值 / 运行实例 env=production / 402 挑战携带真实 serviceId。
    #    这是「切生产」的最后一道闸门——官方硬约束（注册价=实收价、账号一致性）任一不满足，
    #    都会在评审现场变成拒单或计 0。
    echo ""
    echo "▸ 生产就绪自检（prod-check）"
    if node "$PWD/scripts/prod/prod-check.mjs" 2>&1 | sed 's/^/  /'; then
      echo "  ✓ 生产配置自检通过"
    else
      echo "  ⚠ 生产配置自检未全绿——若当前是沙箱部署可忽略；切生产前必须清零上述阻塞项"
    fi
  else
    echo "✗ 健康检查失败：ssh ${HOST} 'cd ${APP_DIR} && docker compose logs --tail 50'" >&2
    exit 1
  fi
  exit 0
fi

SERVER="${SERVER:?用法：TARGET=aliyun bash deploy/deploy.sh　或　SERVER=user@host bash deploy/deploy.sh}"
REMOTE_DIR="${REMOTE_DIR:-/opt/sceneguide}"
PORT="${PORT:-3000}"
HEALTH_PATH="${HEALTH_PATH:-/healthz}"

echo "▸ 发布到 ${SERVER}:${REMOTE_DIR}（端口 ${PORT}）"

# 1) 同步代码。密钥与运行数据永不上传：
#    .alipay-sandbox.json / config/production.json / data/ 只存在于目标机
rsync -az --delete \
  --exclude 'node_modules/' \
  --exclude 'data/' \
  --exclude '.alipay-sandbox.json' \
  --exclude 'config/production.json' \
  --exclude '.git/' \
  --exclude '*.log' \
  ./ "${SERVER}:${REMOTE_DIR}/scene-guide/"

echo "▸ 安装生产依赖"
ssh "$SERVER" "cd ${REMOTE_DIR}/scene-guide && npm ci --omit=dev --no-audit --no-fund --silent"

echo "▸ 重启服务"
ssh "$SERVER" "sudo systemctl restart sceneguide && sleep 2 && systemctl is-active sceneguide"

echo "▸ 健康检查"
if ssh "$SERVER" "curl -sf http://127.0.0.1:${PORT}${HEALTH_PATH}" >/dev/null; then
  echo "✓ ${HEALTH_PATH} 200 —— 发布成功"
  echo "  建议：BASE_URL=http://<服务器地址>:${PORT} bash scripts/verify.sh   # 39 项验收"
else
  echo "✗ 健康检查失败，查看日志：ssh ${SERVER} journalctl -u sceneguide -n 50" >&2
  exit 1
fi
