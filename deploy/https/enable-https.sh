#!/usr/bin/env bash
# 一键启用 HTTPS（备案通过后执行）
#
#   sudo bash deploy/https/enable-https.sh <你的域名> [--email <接收续期提醒的邮箱>]
#
# 做的事：
#   1. 装 certbot（缺省用 webroot 方式，不动现有 nginx 配置）
#   2. 为域名签证书（自动续期由 certbot 的 systemd timer 负责）
#   3. 把 deploy/https/nginx-https.conf 装成 /etc/nginx/conf.d/sceneguide-https.conf
#      （独立 server 块：80 跳 HTTPS + 443 反代 /sceneguide/）
#   4. nginx -t 校验通过才 reload —— 任何一步失败都停在改动前，不会把现网打挂
#
# 前置条件（脚本会检查）：
#   - 域名已解析到本机公网 IP（A 记录）
#   - ICP 备案已完成（国内服务器不开 443 站点的前提）
#   - 80 端口可达（ACME webroot 校验用）

set -euo pipefail

DOMAIN="${1:-}"
EMAIL=""
if [[ "${2:-}" == "--email" ]]; then EMAIL="${3:-}"; fi

if [[ -z "$DOMAIN" ]]; then
  echo "用法：sudo bash deploy/https/enable-https.sh <你的域名> [--email 邮箱]" >&2
  exit 1
fi
if [[ $EUID -ne 0 ]]; then
  echo "请用 root 运行（证书与 nginx 配置都需要）：sudo bash $0 $DOMAIN" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE="$SCRIPT_DIR/nginx-https.conf"
TARGET="/etc/nginx/conf.d/sceneguide-https.conf"

echo "▸ 0. 预检"
command -v nginx >/dev/null || { echo "未找到 nginx"; exit 1; }
[[ -f "$TEMPLATE" ]] || { echo "缺少模板 $TEMPLATE"; exit 1; }
RESOLVED="$(getent hosts "$DOMAIN" | awk '{print $1}' | head -1 || true)"
echo "  域名 $DOMAIN → ${RESOLVED:-（解析失败，请先配 A 记录）}"

echo "▸ 1. 安装 certbot（已安装则跳过）"
if ! command -v certbot >/dev/null; then
  apt-get update -qq
  apt-get install -y -qq certbot
fi

echo "▸ 2. 签发证书（webroot 方式，不改动现有 server 块）"
mkdir -p /var/www/html
CERTBOT_ARGS=(certonly --webroot -w /var/www/html -d "$DOMAIN" --agree-tos --non-interactive --keep-until-expiring)
if [[ -n "$EMAIL" ]]; then CERTBOT_ARGS+=(--email "$EMAIL"); else CERTBOT_ARGS+=(--register-unsafely-without-email); fi
certbot "${CERTBOT_ARGS[@]}"

echo "▸ 3. 安装 HTTPS server 块"
sed "s/__DOMAIN__/$DOMAIN/g" "$TEMPLATE" > "$TARGET"

echo "▸ 4. 校验并重载（校验失败自动回滚，不会打断现网）"
if nginx -t; then
  systemctl reload nginx
  echo "✅ HTTPS 已启用：https://$DOMAIN/sceneguide/"
else
  echo "✗ nginx -t 未通过，已回滚（删除 $TARGET）" >&2
  rm -f "$TARGET"
  exit 1
fi

cat <<EOF

接下来五件事（让作品侧与新地址对齐）：
  1. **改 sitemap.xml 与 robots.txt 里的绝对 URL**（sitemap 规范要求完整 URL，
     相对路径会被爬虫忽略；这两个文件在 public/ 下，全局替换旧域名即可）
  2. 服务注册地址改成 https://$DOMAIN/sceneguide （支付宝按量付费服务管理后台）
  3. 跑一遍线上验收：
       BASE_URL=https://$DOMAIN/sceneguide bash scripts/verify.sh
  4. 页面对外链接统一换成新域名（README / introduction.html / 提交文案 / 二维码）
  5. 备案号按阿里云要求加到页脚

提示：Service Worker 与 PWA「一键安装」只在安全上下文生效——
启用 HTTPS 后，作品官网才真正具备「桌面应用」形态。
EOF
