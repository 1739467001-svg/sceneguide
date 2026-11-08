# 部署

> 目标：把作品从 localhost 部署到公网，供评委访问。
> ⚠️ 前置：正式收款前域名需完成 **ICP 备案**（备案主体须与支付宝账号主体一致，
> 阿里云境内服务器可在控制台直接发起，周期约 7–20 天）。备案期间可先用 IP 或测试域名联调。

## 文件

| 文件 | 用途 |
|---|---|
| `sceneguide.service` | systemd 单元：开机自启、崩溃自动重启 |
| `nginx.conf` | 反向代理 + 静态资源 + gzip + 安全头 |
| `deploy.sh` | 一键发布：同步代码 → 安装依赖 → 重启 → 健康检查 |

## 步骤

### 1. 服务器侧（一次性）

```bash
# 上传部署配置
scp -r deploy/ user@<服务器IP>:/tmp/sceneguide-deploy

# 在服务器上安装 systemd 单元与 nginx 配置
sudo cp /tmp/sceneguide-deploy/sceneguide.service /etc/systemd/system/
sudo cp /tmp/sceneguide-deploy/nginx.conf /etc/nginx/sites-available/sceneguide
sudo ln -sf /etc/nginx/sites-available/sceneguide /etc/nginx/sites-enabled/
sudo mkdir -p /opt/sceneguide && sudo chown $USER /opt/sceneguide
```

### 2. 发布（每次更新后）

```bash
SERVER=user@<服务器IP> bash deploy/deploy.sh
```

脚本会：rsync 代码（排除 node_modules / data / 密钥）→ `npm ci --omit=dev` →
重启 systemd 服务 → `curl /healthz` 健康检查。

### 3. 生产密钥（`service_id` 审核通过后）

在服务器上 `scene-guide/config/production.json` 写入：

```json
{
  "appId": "正式应用AppId",
  "alipayPublicKey": "支付宝公钥",
  "privateKey": "应用私钥（base64 DER）",
  "sellerId": "正式商户PID（2088）",
  "serviceId": "服务市场注册返回的真实 serviceId"
}
```

以 `ALIPAY_ENV=production` 启动（service.service 里已设置）。
**`production.json` 已在 .gitignore 中，永远不会进版本库。**

### 4. HTTPS（备案通过后）

```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d <你的域名>
```

## 验证

```bash
BASE_URL=https://<你的域名> bash scripts/verify.sh   # 31 项验收
```
