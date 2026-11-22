#!/usr/bin/env bash
# ============================================================
# SceneGuide 自愈看门狗（2026-11-22）
#
# 为什么需要：比赛细则硬性要求「参赛者应……并维持作品可用」，
# 初选窗口（12.10–12.14）与决赛公示期间宕机是灾难性的。
# better-sqlite3 崩溃循环事故（11-22）证明：服务可能静默死掉而
# nginx 继续返回 502——必须有一个独立于容器的探活与自愈层。
#
# 行为：每 5 分钟（由 systemd timer 触发）探活 /healthz；
#       失败 → docker compose restart → 记录到 watchdog.log；
#       120 秒内不重复重启（防风暴）；连续失败 3 次追加提醒行。
#
# 安装（服务器，root）：
#   cp /srv/apps/sceneguide/deploy/watchdog.sh /usr/local/bin/sg-watchdog.sh
#   chmod +x /usr/local/bin/sg-watchdog.sh
#   cp /srv/apps/sceneguide/deploy/sceneguide-watchdog.{service,timer} /etc/systemd/system/
#   systemctl daemon-reload && systemctl enable --now sceneguide-watchdog.timer
# ============================================================
set -uo pipefail

APP_DIR="/srv/apps/sceneguide"
LOG="${APP_DIR}/watchdog.log"
URL="http://127.0.0.1:3001/healthz"
MIN_INTERVAL=120   # 两次自愈之间的最小间隔（秒）

mkdir -p "$(dirname "$LOG")"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG"; }

if curl -sf --max-time 10 "$URL" >/dev/null 2>&1; then
  exit 0   # 健康，静默退出（不打日志，避免刷屏）
fi

# 不健康 → 检查防风暴窗口
NOW=$(date +%s)
LAST=0
[[ -f /tmp/sg-watchdog-last-restart ]] && LAST=$(cat /tmp/sg-watchdog-last-restart)
if (( NOW - LAST < MIN_INTERVAL )); then
  log "SKIP 重启过于频繁（上次 $(( NOW - LAST ))s 前），本轮仅记录失败"
  exit 0
fi

FAIL_STREAK=$(cat /tmp/sg-watchdog-streak 2>/dev/null || echo 0)
FAIL_STREAK=$(( FAIL_STREAK + 1 ))

log "FAIL healthz 不通，执行 docker compose restart（连续第 ${FAIL_STREAK} 次）"
echo "$NOW" > /tmp/sg-watchdog-last-restart

cd "$APP_DIR" && docker compose restart >> "$LOG" 2>&1

sleep 20
if curl -sf --max-time 10 "$URL" >/dev/null 2>&1; then
  log "OK   重启后恢复"
  echo 0 > /tmp/sg-watchdog-streak
else
  echo "$FAIL_STREAK" > /tmp/sg-watchdog-streak
  if (( FAIL_STREAK >= 3 )); then
    log "!!!! 连续 ${FAIL_STREAK} 次自愈失败——需要人工介入（docker compose logs --tail 50 sceneguide）"
  fi
fi
