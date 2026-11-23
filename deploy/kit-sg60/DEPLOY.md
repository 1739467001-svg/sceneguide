# 三维问路 SceneGuide · Compose 部署手册（现网在 aliyun）

> 访问地址：https://121.43.80.231/sceneguide/ （暂无域名，IP 直连）
> 本手册最初写给 60.205.204.162（sg60）；该机已不可达，同一套 kit 平移到 **aliyun（121.43.80.231）**
> 继续当生产用——命令里的 `TARGET=sg60` 请相应改成 `TARGET=aliyun`。
> 布局遵循 /srv/DEPLOYMENT.md；本文件是项目级操作手册。

## 目录与端口

| 项 | 值 |
|---|---|
| 应用目录 | /srv/apps/sceneguide/（compose + app/ + data/） |
| 容器 | sceneguide（node:20-bookworm，依赖在构建期烤进镜像，启动不跑 npm ci） |
| 端口 | 127.0.0.1:3001 → 容器 3000（nginx 反代 /sceneguide/） |
| 健康检查 | GET /healthz（容器内置，30s 间隔） |

## 日常更新

```bash
TARGET=aliyun bash deploy/deploy.sh    # 构建镜像 → 上传镜像 → 场景同步 → 重建容器 → 健康检查
```

> 发布后记得核对静态资源版本号：index.html 里 `styles.css?v=` 与 `app.js?v=` 必须同版本，
> 漏改会让评委命中旧缓存（历史踩过两次）。
>
> 🔴 **2026-11-21 起发布流程已变**：代码全在镜像里，`docker compose restart` 不换镜像、
> 新代码不生效。deploy.sh 现在会「本机构建 amd64 镜像 → save/load → `compose up -d`」，
> 不要再手动 restart 来代替发布。

## 日志

```bash
docker logs sceneguide --tail 100        # json-file 轮转 1m×3
docker inspect sceneguide --format '{{.State.Health.Status}}'
curl -s http://127.0.0.1:3001/healthz    # 含 db: {orders, analytics} 体检结果
```

## 备份

- 数据库 + 场景：部署后配置 /usr/local/bin/sceneguide-backup（systemd timer 每日 03:20）
- 手动：cp data/*.db /srv/backup/sceneguide/
- 日常体检：`node scripts/db-check.mjs`（两库 quick_check + 各表行数，可进监控）

## 回滚

```bash
cd /srv/apps/sceneguide && docker compose down -v
# 重新部署：解压上一版 tar 包到 app/ → compose up -d
# 镜像级回滚：docker load < 上一版 sceneguide-1.0.tar.gz → docker compose up -d
```

## 已知故障自查

- 502 但容器 healthy：`ss -lnt | grep 3001`——docker-proxy 槽丢失时 `docker restart sceneguide` 即恢复
- 全站突然无响应：内存死机特征（本机 2G），直接重启实例，不要折腾
- 支付类接口全部报错但页面正常：**先查数据库**——
  `node scripts/db-check.mjs` 或 `curl -s http://127.0.0.1:3001/healthz | jq .db`。
  2026-11-21 本地遇到过库损坏，现象就是「支付未完成」这种没有线索的报错。
