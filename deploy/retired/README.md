# deploy/retired/ —— 已退役的部署路径（2026-11-21 起不再使用）

现网跑 **Docker Compose**（`../kit-sg60/compose.yml`），对外只挂 `/sceneguide/` 子路径。
这里放的是「裸机 systemd + 根路径部署」时代的遗留配置，保留仅作历史记录与故障复盘参考。

| 文件 | 原用途 | 为什么退役 |
|---|---|---|
| `nginx.conf` | 裸机 nginx 站点模板 | 现网是共享 nginx 的 location 片段接入（`../kit-sg60/nginx-sceneguide.conf`），不再需要独立 server 块；且本文件自称「端口 3100 与 sceneguide.service 一致」而 service 实际是 3000，**本身就有矛盾，勿直接使用** |
| `sceneguide.service` | 裸机 systemd 单元 | 同上，被 Compose（`restart: unless-stopped` + 内置 healthcheck）取代 |

如需裸机部署，先读上面两行的问题再决定，或直接用 `../kit-sg60/` 的 Compose 套件。
