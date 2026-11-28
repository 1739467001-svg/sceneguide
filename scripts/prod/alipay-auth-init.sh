#!/usr/bin/env bash
# 重新发起「AI 按量付费」产品级授权（AI 付一键开通链路的第一道门）
#
# 为什么单独写这个脚本：
#   官方 auth init 要带 7 个长参数，其中 mcc-context-receipt 有 900 多字符——
#   手抄一次错一个字符就是一轮「授权失败 → 查半天的上下文不匹配」。
#   参数全部来自 config/alipay-onboarding.json（进仓库，可复现）。
#
# 为什么必须先 logout：
#   auth init 在「已登录但产品上下文无效」时走 AUTH_FLOW:SKIP 分支，
#   **不会**重新发起授权；而它要发的那个链接（aipay.alipay.com/cli-auth?deviceCode=…
#   &productCode=…&mccCode=…）才带产品/MCC 绑定，CLI 那个 verification_url 不带。
#   ⇒ 已经授权过、又发现上下文不对时，先 logout 再跑本脚本。
#
# 用法：
#   bash scripts/prod/alipay-auth-init.sh          # 发起授权并打开页面
#   bash scripts/prod/alipay-auth-init.sh --logout # 先登出再发起（换上下文时用）
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CFG="$ROOT/config/alipay-onboarding.json"
export PATH="$PATH:$HOME/.local/bin:/opt/homebrew/bin"

command -v alipay-cli >/dev/null || { echo "❌ 找不到 alipay-cli"; exit 1; }
command -v node >/dev/null || { echo "❌ 找不到 node"; exit 1; }
[ -f "$CFG" ] || { echo "❌ 缺少 $CFG"; exit 1; }

read_cfg() { node -e "const c=require('$CFG');console.log(c['$1'] ?? '')"; }

SKILL_DIR="$(read_cfg _skill_dir)"
RUNTIME="$SKILL_DIR/references/normal/scripts/runtime.mjs"
[ -x "$RUNTIME" ] || [ -f "$RUNTIME" ] || { echo "❌ 找不到官方 runtime：$RUNTIME"; exit 1; }

if [[ "${1:-}" == "--logout" ]]; then
  echo "▸ 先登出（否则 auth init 会走 SKIP 分支，不重新发起授权）"
  alipay-cli logout || true
fi

echo "▸ 发起产品级授权（产品：$(read_cfg product_name) / 类目：$(read_cfg mcc_code)）"
OUT=$(node "$RUNTIME" auth init --defer-open \
  --scope "$(read_cfg scope)" \
  --sales-code "$(read_cfg sales_code)" \
  --mcc-code "$(read_cfg mcc_code)" \
  --product-name "$(read_cfg product_name)" \
  --mcc-name "$(read_cfg mcc_name)" \
  --mcc-context-receipt "$(read_cfg mcc_context_receipt)" 2>&1)

URL=$(printf '%s\n' "$OUT" | grep -o 'https://aipay\.alipay\.com/cli-auth[^ ]*' | head -1)
CODE=$(printf '%s\n' "$OUT" | grep -oE '确认码 \| [0-9]+' | grep -oE '[0-9]+' | head -1)
if [ -z "$URL" ]; then
  echo "❌ 没拿到授权链接，原始输出："
  printf '%s\n' "$OUT" | head -30
  exit 1
fi

printf '%s\n' "$OUT" | grep -vE '^ALIPAY_AIPAY_INTERNAL' | head -20
echo
echo "🔗 授权链接：$URL"
echo "🔢 确认码（核对用，不用输入）：${CODE:-见页面}"
echo

# 打开页面（官方受控 opener + 系统默认浏览器兜底）
node "$RUNTIME" auth open 2>&1 | head -2 || true
open "$URL" 2>/dev/null || true
echo "▸ 页面已打开。请用**支付宝 App 扫码**，并核对页面上的确认码与上面一致。"
echo "▸ 授权完成后跑：node '$RUNTIME' auth wait"
