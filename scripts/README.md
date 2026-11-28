# scripts/ —— 全部 43 个脚本的分类索引

> 这个目录按**子目录分组**（`test/` `verify/` `prod/` `build/`），两个人类入口留在根部。
> 想知道「要跑什么」先看这里，再决定要不要读源码。
>
> **运行前提**：除标注「需本地服务 / 需沙箱 / 需生产」的外，其余都可直接 `node <脚本>` 跑。
> `build/` 下多数脚本按 `process.cwd()` 定位输出目录，必须**在 `scene-guide/` 根目录**执行。

## 快捷入口

| 想做什么 | 跑什么 |
|---|---|
| 跑全部自动化测试（540 项，约 40 秒） | `npm test` |
| 只跑协议主路径自检（70 项） | `npm run smoke` |
| 体检两个数据库 | `node scripts/db-check.mjs` |
| 部署前对线上跑全量验收（77 项） | `bash scripts/verify.sh` |
| 重新抓 402 协议报文 | `npm run trace` |
| 生成 PWA 图标 | `npm run icons` |

---

## 根部 —— 两个人类入口

| 脚本 | 用途 |
|---|---|
| `verify.sh` | **端到端验收总入口**（77 项）。按序调用 `verify/`、`prod/` 下的子脚本与 `db-check.mjs`，需本地服务 + 沙箱 |
| `db-check.mjs` | 两个库的 `quick_check` + 各表行数。退出码 0=健康、1=有库损坏，可进 CI/监控。恢复步骤见 `src/orders/repository.js` 启动体检输出 |

> 这两个刻意留在根部：它们是被文档反复引用的稳定路径（`bash scripts/verify.sh` / `node scripts/db-check.mjs`），
> 搬走会让 5 份以上的文档与运维手册同时失效。

## test/ —— 自动化测试套件（4 个）

`npm test` 依次跑完这四个。全部在 `os.tmpdir()` 的临时库上运行，**不碰 `data/` 下的真实库**，不联网。

| 脚本 | 项数 | 覆盖 |
|---|---|---|
| `smoke.js` | 70 | 协议与内核主路径：实体消解、意图识别、最短路、证据哈希、402 响应、商家签名验签、订单持久化、幂等履约、数据诚信口径 |
| `test-deep.js` | 276 | 服务端模块深度：权益台账 FIFO/过期/归还、礼品码、退款全路径、打卡闭环、崩溃孤儿恢复、增长漏斗口径、反馈墙、402 付费/重放/额度交付 HTTP 全链路、MCP、限流、404 改写 |
| `test-deep2.js` | 145 | 场景数据完整性（悬空引用/重复 ID/自环/坐标）、代付链路、支付宝客户端重试口径、并发原子性、前后端字段契约、工程健全性、DB 升级迁移 |
| `test-http.js` | 49 | HTTP 层本身：安全响应头、缓存策略、ETag/304、gzip、trust proxy、生产配置路径、网关不可达降级 |

## verify/ —— 验收子脚本（10 个，需本地服务）

由 `verify.sh` 调用，也可单独跑。`verify.sh` 是总入口。

| 脚本 | 用途 |
|---|---|
| `verify-mcp-flow.mjs` | Agent 路径：`tools/list` → 真实 402 → 沙箱收银 → 带凭证 `tools/call` → 幂等重放 |
| `verify-account-flow.mjs` | 买家路径：买十次包 → 礼品码转赠 → 兑换 → 余额交付 → 撤销 → 退款回收 |
| `verify-render.mjs` | 三维渲染完整性（浏览器层） |
| `verify-channel-qr.mjs` | 渠道二维码指向校验 |
| `verify-community-share.mjs` | 官方作品页分享链路 |
| `verify-honest-numbers.mjs` | 数字诚信自检（README 声称的数字 vs 实测） |
| `verify-input-hardening.mjs` | 输入健壮性压测 |
| `verify-official-limits.mjs` | 官方接口字段限额自检 |
| `verify-prod-cutover.mjs` | 生产切换链路契约自检 |
| `verify-shell-unicode.mjs` | Shell 脚本「变量名后紧跟非 ASCII 字符」检测 |

## prod/ —— 生产切换与支付核验（14 个，需沙箱或生产密钥）

| 脚本 | 用途 |
|---|---|
| `prod-cutover.mjs` | 生产切换一条龙（会调用 `prod-check.mjs` 与 `deploy/deploy.sh`） |
| `prod-check.mjs` | 生产切换自检 |
| `prod-pay-ux-check.mjs` | 生产模式支付体验自检（用临时配置起本地生产实例） |
| `precreate-check.mjs` | 官方预下单（`amtPaymentLink`）自检 |
| `https-hard-constraint-check.mjs` | 「付费资源必须 HTTPS」硬约束自检 |
| `notify-check.mjs` | 官方支付异步通知自检 |
| `alipay-auth-init.sh` | 重新发起「AI 按量付费」产品级授权 |
| `check-sign-status.mjs` | 查签约状态 |
| `official-buyer-check.sh` | 官方买方脚本联调 |
| `first-trade-no.mjs` | 取首笔生产真实交易号 |
| `fill-work-url.mjs` | 把官方作品详情页 URL 灌进分发文案包 |
| `judge-flow.mjs` | 冷评委路径验收 |
| `judge-path-check.mjs` | 按提交表单「如何获取作品」的 7 步逐条核对站点入口 |
| `protocol-unit-check.mjs` | 协议层单元自检 |

## build/ —— 构建与素材（12 个）

| 脚本 | 用途 |
|---|---|
| `build-scene-from-osm.mjs` | 从 OpenStreetMap 生成场景数据（下沙校区 / 良渚文化村） |
| `build-review-zip.mjs` | 评审附件包构建器（按 `config/review-package.json` 打包） |
| `submission-readiness-check.mjs` | 提交就绪闸门（核对包内文件是否比源文件旧） |
| `build-intro-pdf.sh` | 从 HTML 源重新渲染《作品介绍文档.pdf》 |
| `capture-protocol-trace.js` | 抓一次真实的 402 协议往返，存成静态数据供站点展示 |
| `capture-api-reference.js` | 抓各 API 端点真实响应，生成 API 参考数据 |
| `capture-storyboard.mjs` | 分镜截图采集（11 张目标画面） |
| `record-demo.mjs` | 演示视频自动录制（CDP screencast → ffmpeg） |
| `make-icons.mjs` | 生成 PWA 图标（纯 PNG 编码，无第三方依赖） |
| `make-invites.mjs` | 渠道邀请包生成器 |
| `make-qr.mjs` | 渠道二维码生成器 |
| `probe-render.mjs` | 公网页面 3D 初始化探针（收集 console/error + `__scene3d` 状态） |

---

## 添加新脚本时

1. 按用途放进对应子目录，命名带上前缀（`verify-` / `prod-` / `build-` / `capture-` / `make-`）
2. 在本文件对应分组里加一行
3. 若被 `verify.sh` 调用，用 `"$SCRIPT_DIR/<组>/<名字>"` 的形式（它按 `BASH_SOURCE` 定位，与脚本自身位置无关）
4. 全项目对 `scripts/…` 的引用都有校验：改名前先全局搜一遍 `scripts/<名字>`，确认没有遗漏
