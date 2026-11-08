#!/usr/bin/env bash
# ============================================================
# SceneGuide 一键发布
#
#   SERVER=user@<服务器IP> bash deploy/deploy.sh
#
# 流程：rsync 代码（排除密钥/数据/依赖）→ 服务器上 npm ci --omit=dev
#       → systemctl restart → /healthz 健康检查
# ============================================================
set -euo pipefail

# 目标一（aliyun，当前线上实例）：
#   TARGET=aliyun bash deploy/deploy.sh
#   → rsync 到 /srv/apps/sceneguide/app/ → docker compose restart → 健康检查
# 目标二（systemd 裸机，60.205.204.162）：
#   SERVER=root@60.205.204.162 bash deploy/deploy.sh

TARGET="${1:-${TARGET:-}}"

if [[ "$TARGET" == "aliyun" ]]; then
  set -euo pipefail
  HOST="${SERVER:-aliyun}"
  APP_DIR="/srv/apps/sceneguide/app"
  PORT=3001
  echo "▸ 发布到 ${HOST}:${APP_DIR}（Docker Compose · 端口 ${PORT}）"

  # 密钥与运行数据永不上传（服务器侧已有权威副本）
  tar -czf /tmp/sg-src.tar.gz --exclude 'node_modules' --exclude 'data' \
    --exclude '.alipay-sandbox.json' --exclude 'config/production.json' \
    --exclude '.git' --exclude '*.log' \
    -C "$(pwd)" public src scripts config SKILL.md package.json package-lock.json README.md
  scp -q /tmp/sg-src.tar.gz "$HOST:/tmp/"
  ssh "$HOST" "cd ${APP_DIR} && tar -xzf /tmp/sg-src.tar.gz && rm /tmp/sg-src.tar.gz"
  rm -f /tmp/sg-src.tar.gz

  echo "▸ 重启容器（deps 卷已存在时跳过 npm ci，约 8s）"
  ssh "$HOST" "cd /srv/apps/sceneguide && docker compose restart"

  echo "▸ 健康检查（重试 30s）"
  OK=""
  for i in $(seq 1 10); do
    sleep 3
    if ssh "$HOST" "curl -sf http://127.0.0.1:${PORT}/healthz" >/dev/null; then OK=1; break; fi
  done
  if [[ -n "$OK" ]]; then
    echo "✓ 发布成功"
    echo "  验收：BASE_URL=http://121.43.80.231/sceneguide bash scripts/verify.sh"
  else
    echo "✗ 健康检查失败：ssh ${HOST} 'cd /srv/apps/sceneguide && docker compose logs --tail 50'" >&2
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
