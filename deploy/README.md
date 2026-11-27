# 部署

> 目标：把作品从 localhost 部署到公网，供评委访问。
> ⚠️ 前置：正式收款前域名需完成 **ICP 备案**（备案主体须与支付宝账号主体一致，
> 阿里云境内服务器可在控制台直接发起，周期约 7–20 天）。备案期间可先用 IP 或测试域名联调。

---

## 🔴 现网实况（2026-11-20 更新，以本节为准）

**现网跑的是 Docker Compose，不是下面「步骤」里描述的裸机 systemd 路径**（那条路径已退役，
保留在下方仅作历史记录）。当前实况：

| 项 | 值 |
|---|---|
| 线上地址 | `https://121.43.80.231/sceneguide/`（aliyun，1.6G 内存） |
| 运行方式 | Docker Compose（`kit-sg60/compose.yml`，容器 `sceneguide`，镜像 `sceneguide:1.0`） |
| 宿主机目录 | `/srv/apps/sceneguide/app/`（代码）+ `/srv/apps/sceneguide/data/`（卷） |
| 端口 | 容器 3000 → 宿主机 `127.0.0.1:3001`（仅回环，外网不可直连） |
| 对外反代 | 共享 nginx 的 location 片段 `kit-sg60/nginx-sceneguide.conf`，前缀 `/sceneguide/` |
| 发布命令 | `TARGET=aliyun bash deploy/deploy.sh`（本机构建 amd64 镜像 → 上传镜像 → `compose up -d` 重建容器 → 健康检查，约 1–2 分钟） |
| 运行环境 | `ALIPAY_ENV=sandbox`（沙箱；切生产见下方「生产密钥」） |
| HTTPS | **未启用**（域名备案中）。就绪包在 `https/`，备案通过后一条命令启用 |

> 🔴 **2026-11-21 关键修正**：compose 只挂 `./data`，`src/` 与 `public/` **全烤在镜像里**。
> 因此「上传代码 + `docker compose restart`」**不会让新代码生效**——容器跑的仍是旧镜像，
> 而健康检查一切正常（线上曾因此长期停在旧版本，极难察觉）。
> 正确做法已写进 `deploy.sh`：本机构建 amd64 镜像 → `docker save` 上传 → `docker load`
> → `docker compose up -d`（重建容器）。**`restart` 不换镜像，`up -d` 才换。**

> `kit-sg60/DEPLOY.md` 里的访问地址（60.205.204.162）是 sg60 还是主力机时的旧记录，
> 该机安全组未放行 22/80（ICMP 通、TCP 不通，非死机）；同一套 kit 平移到 aliyun 继续当生产用。

### 备案通过后的 HTTPS 一键启用

```bash
sudo bash deploy/https/enable-https.sh <你的域名>
```

脚本自动：装 certbot → 签证书 → 装独立 server 块（80 跳 HTTPS + 443 反代 `/sceneguide/`）→
`nginx -t` 通过才 reload（失败自动回滚）。详见 `https/` 目录。

---

## 文件

| 文件 | 用途 |
|---|---|
| `deploy.sh` | 一键发布（Compose 路径为现网主力；systemd 路径为历史备用） |
| `kit-sg60/` | 现网 Compose 套件：compose.yml + nginx location 片段 + 运维手册 |
| `https/` | HTTPS 就绪包：nginx 443 server 块模板 + certbot 一键脚本 |
| `sceneguide.service` | 【历史】裸机 systemd 单元（已退役路径） |
| `nginx.conf` | 【历史】裸机 nginx 站点模板（已退役路径，端口描述与 service 文件有出入，勿直接使用） |
| `服务器部署清单.md` | 真实线上状态、踩坑记录与升级七步 |

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
sudo bash deploy/https/enable-https.sh <你的域名>
```

（旧的手动步骤 `certbot --nginx` 亦可，但会改写现有 server 块；
`https/enable-https.sh` 装的是独立 server 块，不动共享 nginx 的现有配置，失败可回滚。）

## 验证

```bash
BASE_URL=https://121.43.80.231/sceneguide bash scripts/verify.sh   # 88 项验收（含 MCP Agent 链路与买家账户中心）
```
