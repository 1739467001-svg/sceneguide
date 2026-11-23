# SceneGuide · 裸 IP HTTPS（Let's Encrypt shortlived）

> 2026-11-23 上线。解决的问题：**Chrome 157 起会把 `http://<裸IP>` 自动升级为 `https://<裸IP>`**，
> 若 443 没有有效 TLS，浏览器**硬拦截**到 `chrome-error://chromewebdata/`——
> 不是警告页、也没有「继续访问」链接，评委点开演示链接会看到一片空白。
>
> 常规解法是「买域名 + ICP 备案 + 上证书」，但比赛只剩 16 天，备案周期（7–20 天）不可控。
> 突破口：**Let's Encrypt 已支持为裸 IP 签发短期证书**（`shortlived` profile，SAN = `IP:x.x.x.x`，
> 有效期约 6 天）——**不需要域名、不需要备案**。

## 一次性安装（在服务器上执行）

```bash
# 1) 取得 lego（新版才有 --profile；旧版 certbot 2.9 客户端自己就会拒绝 IP）
curl -sSL -o /tmp/lego.tar.gz \
  "https://github.com/go-acme/lego/releases/download/v5.7.0/lego_v5.7.0_linux_amd64.tar.gz"
tar -xzf /tmp/lego.tar.gz -C /tmp lego && install -m 0755 /tmp/lego /usr/local/bin/lego

# 2) 签发（http-01 校验需要占用 80 端口 → 短暂停 nginx）
systemctl stop nginx
/usr/local/bin/lego run --email <你的邮箱> --accept-tos \
  --http --http.address :80 --path /root/.lego --profile shortlived \
  -d 121.43.80.231
systemctl start nginx
```

产物：`/root/.lego/certificates/121.43.80.231.{crt,key}`（`issuer.crt` 同目录）。

## nginx 配置

`/etc/nginx/conf.d/sceneguide-https.conf`：

```nginx
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name 121.43.80.231 _;

    ssl_certificate     /root/.lego/certificates/121.43.80.231.crt;
    ssl_certificate_key /root/.lego/certificates/121.43.80.231.key;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 1d;

    include /etc/nginx/app-routes/sceneguide.conf;   # 与 80 端口同一份子路径路由

    location = / { return 302 /sceneguide/; }
    location / { return 404; }
}
```

> ⚠️ 老版 nginx（1.18）**不支持 `http2 on;`** 指令——写在 `listen 443 ssl http2;` 里，
> 写错会直接 `nginx -t` 失败（unknown directive "http2"）。

## 自动续期（证书只有 6 天有效期，必须续）

`/usr/local/bin/lego-renew.sh` + `sg-cert-renew.timer`（每 12 小时检查一次，
剩余有效期 < 3 天才续，续期时短暂停 nginx 再 reload）。

```bash
systemctl enable --now sg-cert-renew.timer
systemctl list-timers sg-cert-renew.timer
tail -20 /var/log/sg-cert-renew.log
```

## 验证

```bash
# 证书链有效（不加 -k）
curl -s -o /dev/null -w "%{http_code}\n" https://121.43.80.231/sceneguide/
openssl s_client -connect 121.43.80.231:443 </dev/null | grep -A1 "subject alternative"

# 模拟评委：Chrome 默认参数访问 http:// 应自动升级并成功加载
node scripts/probe-render.mjs    # BASE_URL 默认打 https://121.43.80.231/sceneguide
```

## 副作用（好事）

安全上下文成立 → **Service Worker 正常注册 → PWA「可安装」（桌面应用交付形态）真实可用**
（此前 HTTP 部署下这一承诺不成立）。`public/app.js` 的 SW 注册逻辑本身已按
`window.isSecureContext` 判断，无需改动。

## 兜底

- 证书万一过期：`sg-cert-renew.timer` 会在 12 小时内自动重签
- 极端情况下证书失效，HTTP 入口仍可用：`http://121.43.80.231/sceneguide/`
  （Safari / Firefox / 内嵌浏览器不会自动升级，可直接用）
