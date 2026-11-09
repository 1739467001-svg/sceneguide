# 三维问路 SceneGuide · 60.205.204.162 部署手册

> 访问地址：http://60.205.204.162/sceneguide/ （暂无域名，IP 直连）
> 布局遵循 /srv/DEPLOYMENT.md；本文件是项目级操作手册。

## 目录与端口

| 项 | 值 |
|---|---|
| 应用目录 | /srv/apps/sceneguide/（compose + app/ + data/） |
| 容器 | sceneguide（node:20-bookworm，npm ci 启动时执行） |
| 端口 | 127.0.0.1:3001 → 容器 3000（nginx 反代 /sceneguide/） |
| 健康检查 | GET /healthz（容器内置，30s 间隔） |

## 日常更新

```bash
TARGET=sg60 bash deploy/deploy.sh     # 本机打包 → 上传 → 场景同步 → 重启 → 健康检查
```

## 日志

```bash
docker logs sceneguide --tail 100        # json-file 轮转 1m×3
docker inspect sceneguide --format '{{.State.Health.Status}}'
```

## 备份

- 数据库 + 场景：部署后配置 /usr/local/bin/sceneguide-backup（systemd timer 每日 03:20）
- 手动：cp data/*.db /srv/backup/sceneguide/

## 回滚

```bash
cd /srv/apps/sceneguide && docker compose down -v
# 重新部署：解压上一版 tar 包到 app/ → compose up -d
```

## 已知故障自查

- 502 但容器 healthy：`ss -lnt | grep 3001`——docker-proxy 槽丢失时 `docker restart sceneguide` 即恢复
- 全站突然无响应：内存死机特征（本机 2G），直接重启实例，不要折腾
