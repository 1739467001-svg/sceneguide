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

# 目标一（sg60，当前线上实例 60.205.204.162）：
#   TARGET=sg60 bash deploy/deploy.sh
#   → 打包上传 /srv/apps/sceneguide/app/ → 场景同步进挂载卷 → compose 重启 → 健康检查
# 目标二（systemd 裸机，其它机器）：
#   SERVER=root@<ip> bash deploy/deploy.sh

TARGET="${1:-${TARGET:-}}"

# 目标映射：aliyun = 当前生产（121.43.80.231）；sg60 = 备用机（60.205.204.162，待恢复）
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
      || { echo "✗ 60.205.204.162 不可达（死机）。生产在 aliyun：TARGET=aliyun"; exit 1; }
  fi
  APP_DIR="/srv/apps/sceneguide/app"
  PORT=3001
  echo "▸ 发布到 ${HOST}:${APP_DIR}（Docker Compose · 端口 ${PORT}）"

  # 密钥与运行数据永不上传（服务器侧已有权威副本）；
  # data/scenes/*.json 是构建产物（纯 OSM 衍生数据、无密钥无用户数据），必须随包发布
  tar -czf /tmp/sg-src.tar.gz --exclude 'node_modules' --exclude 'data/*.db*' \
    --exclude 'data/analytics*' --exclude 'data/orders*' \
    --exclude '.alipay-sandbox.json' --exclude 'config/production.json' \
    --exclude '.git' --exclude '*.log' \
    -C "$(pwd)" public src scripts config SKILL.md package.json package-lock.json README.md data/scenes
  scp -q /tmp/sg-src.tar.gz "$HOST:/tmp/"
  ssh "$HOST" "cd ${APP_DIR} && tar -xzf /tmp/sg-src.tar.gz && rm /tmp/sg-src.tar.gz"
  rm -f /tmp/sg-src.tar.gz
  # 🔴 场景数据必须落到挂载卷：compose 把 ../data 挂载为容器的 /app/data，
  #    解压到 app/data/scenes 会被卷遮蔽（历史踩过一次 404 三连）。
  ssh "$HOST" "mkdir -p /srv/apps/sceneguide/data/scenes && cp -f ${APP_DIR}/data/scenes/*.json /srv/apps/sceneguide/data/scenes/ 2>/dev/null || true" 

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
