#!/usr/bin/env bash
# 从 HTML 源重新渲染《作品介绍文档.pdf》（评委版一页说明书）
#
# 为什么值得一个脚本：
#   PDF 是**渲染产物**，HTML 才是源。2026-11-27 发现 PDF 里写着「84 项」
#   而 HTML 源早已是「88 项」——PDF 停留在 11-24 那次渲染，
#   而验收计数在 11-24 之后又加了 4 项。评委拿到的是 PDF，
#   站点和提交文案写的却是 88，一眼就看出「文档没跟着代码走」。
#   没有脚本的结果就是：每次改完 HTML 都会忘记重渲 PDF。
#
# 渲染后自动做两件事（不然还是会漂移）：
#   ① 校验 PDF 能解析出页数
#   ② 校验 PDF 文本里的「N 项」与 HTML 源里的**完全一致**
#
# 用法：bash scripts/build/build-intro-pdf.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MAT="$ROOT/提交材料"
HTML="$MAT/作品介绍文档.html"
PDF="$MAT/作品介绍文档.pdf"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

[ -f "$HTML" ] || { echo "❌ 缺少源文件：$HTML"; exit 1; }
command -v pdftotext >/dev/null || { echo "❌ 缺少 pdftotext（poppler）"; exit 1; }

TMP_PDF="$(mktemp -u)/out.pdf"
mkdir -p "$(dirname "$TMP_PDF")"

echo "▸ 渲染 HTML → PDF（Chrome print-to-pdf）"
PROFILE="$(mktemp -d)"
trap 'rm -rf "$PROFILE" "$(dirname "$TMP_PDF")"' EXIT

"$CHROME" \
  --headless=new --disable-gpu --no-pdf-header-footer \
  --print-to-pdf="$TMP_PDF" \
  --user-data-dir="$PROFILE" \
  --virtual-time-budget=8000 \
  "file://$HTML" 2>&1 | grep -vE '^\[|DevTools|Fontconfig|Trying to load' || true

[ -s "$TMP_PDF" ] || { echo "❌ 渲染失败：未生成 PDF"; exit 1; }
cp "$TMP_PDF" "$PDF"
echo "  ✓ 已写入 ${PDF}（$(du -k "$PDF" | cut -f1)KB）"

# ── ① 页数 ─────────────────────────────────────────────────
PAGES=$(pdftotext -layout "$PDF" - 2>/dev/null | grep -c $'\f' || true)
# pdftotext 每页末尾一个换页符；最后一页后也有，所以页数 = 换页符数
if [ "$PAGES" -lt 1 ]; then
  # 兜底：用 /Type /Page 数
  PAGES=$(strings "$PDF" | grep -c '/Type */Page[^s]' || true)
fi
echo "  ✓ 页数：$PAGES"
[ "$PAGES" -ge 3 ] || { echo "❌ 页数异常（${PAGES}）——排版可能塌了"; exit 1; }

# ── ② 计数一致性：PDF 文本 vs HTML 源 ─────────────────────
HTML_COUNT=$(grep -oE '[0-9]+ 项' "$HTML" | head -1 | grep -oE '[0-9]+')
PDF_TEXT=$(pdftotext -layout "$PDF" - 2>/dev/null)
PDF_COUNTS=$(printf '%s' "$PDF_TEXT" | grep -oE '[0-9]+ 项' | sort -u | tr '\n' ' ')
echo "  HTML 源计数：${HTML_COUNT} 项"
echo "  PDF 内计数  ：${PDF_COUNTS}"
if printf '%s' "$PDF_COUNTS" | grep -q "${HTML_COUNT} 项"; then
  echo "  ✓ PDF 与 HTML 源计数一致（${HTML_COUNT} 项）"
else
  echo "❌ PDF 里找不到 ${HTML_COUNT} 项——源文件改了但 PDF 没重渲，或渲染丢内容"
  exit 1
fi

# ── ③ 不该残留的旧计数 ────────────────────────────────────
if printf '%s' "$PDF_COUNTS" | grep -qvE "(^| )${HTML_COUNT} 项( |$)"; then
  echo "⚠️ PDF 里还出现别的「N 项」：${PDF_COUNTS}——确认它们是有意为之（如子链路项数）"
fi

echo "✅ $PDF 已与 HTML 源同步"
