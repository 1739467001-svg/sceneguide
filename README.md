# 三维问路 · SceneGuide

> **可被 Agent 自动购买的场景导览服务** —— 基于支付宝 A2M 智能收（HTTP 402）按量付费协议。
> 参赛项目：PAYATHON 2026 · Machine Pay 赛道

一个 Agent 说「帮我查一下从南门到图书馆怎么走」，它自己去发现这个服务、**自己完成支付**、然后拿到经过真实地理拓扑验证的路线。不是给人看的界面，是**给 Agent 调用的付费服务**。

---

## 状态

| 项 | 状态 |
|---|---|
| 离线协议自检 | ✅ **42/42 通过**（`npm run smoke`） |
| 官方沙箱端到端联调 | ✅ **通过** —— 官方脚本输出「AI 按量付费沙箱服务端联调通过」 |
| 浏览器端一键支付 | ✅ 页面里点一下即可走完 402 → 沙箱收银 → 履约 → 交付 |
| 真实订单 | ✅ 已产生多笔 `PAID / FULFILLED` 订单（trade_no `...21371` / `...21374`） |
| 真实场景数据 | ✅ 下沙校区 OSM：**176 个命名地标 / 862 路网节点 / 872 条边** |
| 生产环境 | ⬜ 待 `service_id` 审核通过 + 正式密钥 |

沙箱完整链路已验证：**402 Payment-Needed → 支付宝沙箱收银（HTTP 200）→ Payment-Proof 重试 → `payment.verify` 验签 → `fulfillment.confirm` 履约回执 → HTTP 200 交付资源**。

### 参赛作品官网（`public/`）

| 文件 | 作用 |
|---|---|
| `public/index.html` | 单页官网，含 9 个板块 |
| `public/styles.css` | 设计系统（深色技术底、语义状态色、等宽表格数字） |
| `public/app.js` | 交互：画布渲染、支付挑战、协议步骤手风琴、滚动入场 |
| `public/data/protocol-trace.json` | **真实抓取**的 402 协议往返报文（站点降级时回落到它） |
| `public/three-scene.js` | **三维场景模块**（Three.js）：OSM 建筑轮廓拉伸体块、路网线带、地标光柱、发光路线管、轨道相机 |
| `public/manifest.webmanifest` `public/sw.js` | **PWA**：作品可作为「桌面应用」安装（对应 Vibe Pay 的桌面应用交付形态） |
| `public/icon-192.png` `public/icon-512.png` | PWA 图标（`scripts/make-icons.mjs` 纯 PNG 编码生成，无第三方依赖） |
| `public/vendor/` | 本地化的 three.js + OrbitControls（不依赖 CDN，站点可离线跑） |
| `deploy/` | **部署套件**：systemd 单元 + nginx 配置 + 一键发布脚本（含 ICP 备案提示与密钥安全约定） |
| `src/mcp/server.js` | **MCP 服务端**：把付费资源暴露为 MCP 工具，Agent 通过 `tools/list` 即可「发现服务」 |

### 板块与评审标准的对位

| 板块 | 对应评审维度 | 提供的证据 |
|---|---|---|
| Hero 协议终端 | 支付集成度 | 真实 `Payment-Needed` / `Payment-Validation` 报文 |
| 实时演示 | 产品完整度 | **三维场景**（真实建筑轮廓拉伸）+ 查询 + 一键支付 + 拓扑平面图切换 |
| 支付链路 | 支付集成度 | 五步协议 + 逐步展开的真实报文 + 五项核验 |
| 赛道契合 | —— | 四条赛道官方原文 + 各自的提交物 |
| 商业化 | 商业化表现 | 三档商品、五维计量、实时订单看板 |
| Agent 接入 | —— | `SKILL.md` 与买方 CLI 全流程 |
| **交付与验收** | 作品影响力 / 信任 | 四条赛道各一份提交物 + 8 条可自行执行的验收项 + **随作品交付的验收脚本** |
| **交易链路全貌** | Agent Pay 契合 | 发现（实时 MCP `tools/list`）→ 支付 → 交付 → 结算，四环逐环给证据 |
| **API 参考** | 支付集成度 | 六个端点的参数表与**真实响应**（非手写示例） |
| 工程细节 | 支付集成度 | 三个实测踩坑 + 订单状态机 |
| 数据 | 作品影响力 | OSM 构建管线可复现 + 几何哈希 |

### 本地预览

```bash
npm start
open http://localhost:3000/
```

### 增长归因与反刷量设计

评审标准「商业化表现：是否获得**真实、有效的付费用户**」隐含两件事：能区分真实用户与自买自卖；能说明用户从哪来。为此：

- **渠道归因**：`?ref=渠道码` / 短链 `/r/:code`，首触绑定访客（随机 cookie，不存个人信息，IP 只存加盐哈希）
- **订单来源标注**：`source=demo`（沙箱演示代付自测）与 `source=api`（外部真实调用）分列，
  看板中自测订单**永远不计入「真实付费用户」**
- **转化漏斗**：访客 → 免费试看 → 发起支付 → 付费，按渠道拆分，`GET /api/v1/growth`
- **免费试看**：每人每天 3 次（服务端计数限流），只给答案文本；路线图/距离/证据哈希是付费价值
- **渠道分享包**：`node scripts/make-invites.mjs` 为 7 类社群生成带归因的链接与文案

### 研学任务（¥9.90 档位）—— 完整的打卡闭环

「一次任务是一个可交付的教育产品」——演示区可切换「研学任务」模式现场体验：

- 任务引擎自动挑打卡点，**优先取「命名地标最多」的连通分量**——
  不是节点最多的分量（那往往是一片纯路网，地标稀少）。
  这样任务的每一段都是实测步道（`measured: true`），研学队真的能走完
- **打卡闭环**（不是「买完发个 PDF」）：
  1. 支付 → 任务落库，状态 `IN_PROGRESS`，**此时没有证书**
  2. 按线索链顺序逐站打卡 —— 服务端核验：未知点拒绝、乱序拒绝、重复拒绝
  3. 全部打卡完成 → 计算评分（基础 100 + 全部完成 30 + 按时完成 20）
  4. **此刻才颁发证书**，哈希覆盖实际打卡记录（任务 id + 各站顺序 + 打卡时刻 + 总里程 + 得分）
- 交付物：线索链 → 打卡点 → 评分规则 → 可核验完成凭证
- MCP 工具 `scene_guide` 同样支持 `mode: 'quest'`——Agent 也能采购研学任务
- 验收脚本第 8 节会真实支付一单任务并校验凭证哈希格式

### 路网是碎的，不假装它是整的

下沙校区的 OSM 步道被切成 38 个连通分量。我们没有生成一张假的示意路网去糊弄演示，而是：

- **路通 → 给实测路径**：117 个去重命名地标中，有 **381 对**之间存在真实步道路由
- **路不通 → 明确标注的直距估算**：响应里用 `route.type`（`walkway` / `direct-estimate`）
  与 `measured`（`true` / `false`）说清楚，绝不编一条路

演示区的默认问题选在真实连通的点对上，因此返回的是实测路径：

```
从A教学楼出发，沿园区步道直达，到达C教学楼，全程约 142 米，步行约 2 分钟。
路径类型：实测步道   ✓ 路径来自 OpenStreetMap 实测步道拓扑
```

同名地标有多个副本时（如三个「行政楼」），只在**同名候选内**挑能走通的那个，
不会偷偷换成别的地标。

### 三维场景

- 建筑体块由 OSM **真实多边形轮廓**拉伸（`scripts/build-scene-from-osm.mjs` 采集 `footprints`）
- 高度按 `building:levels` / `height` 标签取值，缺失时按占地面积估算，**统一夸张 ×3.0 并在界面标注**
- 路线用 CatmullRom 曲线 + TubeGeometry 绘制，沿线有流动光点
- 相机取景**始终收敛到街区尺度**（90–320m）——按 1.2km 路线全长取景会让体块糊成线框
- 场景数据裁剪到 bbox 内：Overpass 的 `out body geom` 返回的是 way 的**完整几何**，
  一条擦过 bbox 角的长路会把包围盒撑到几公里外，必须自己裁

### Agent 发现服务（MCP）

Agent Pay 赛道的描述第一句就是「Agent **发现服务**」。本作品把付费资源暴露为 MCP 工具：

```bash
curl -s -X POST http://127.0.0.1:3000/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

返回两个工具：

| 工具 | 用途 | 计费 |
|---|---|---|
| `scene_guide_scenes` | 场景目录（先确定 scene 参数） | 否 |
| `scene_guide` | 三维场景导览（核心付费工具） | `annotations.paid = true` |

调用 `scene_guide` 而不带凭证时，返回 `payment_required` 与一份账单，并指示 Agent
把账单交给支付宝 `alipay-pay-for-402-service` 技能；付款后把 `Payment-Proof`
以 `payment_proof` 参数回传，即可拿到结果。

### 提交材料（`提交材料/`）

| 文件 | 用途 |
|---|---|
| `服务注册信息包.md` | open-ai-pay 服务注册表单**逐字段照抄**（含请求示例与多档位说明） |
| `作品提交文案.md` | 四条赛道各自的提交说明 + 通用字段，12.09 直接粘贴 |
| `演示录制脚本.md` + `演示分镜/` | 9 镜头跟拍表（含目标画面截图），QuickTime 5 分钟出片 |
| `../deploy/服务器部署清单.md` | 阿里云 IP 直连部署步骤——先让 service_id 注册的「可访问地址」真实可达 |

### 验收脚本

作品随附一份可执行的验收脚本，评委可独立验证各项声明：

```bash
bash scripts/verify.sh                       # 默认 http://127.0.0.1:3000
BASE_URL=https://your-domain bash scripts/verify.sh
```

覆盖 39 项：服务可达性、402 支付挑战与 `Payment-Needed` 解码、真实支付与交付、
幂等履约、计量维度、场景数据真实性与 OSM 归属、协议快照、**MCP 发现能力**、
**研学任务链路（含打卡顺序核验与「完成才发证」）**、站点资源完整性。

### 站点健壮性

- **协议报文是静态快照**：后端挂掉时页面仍展示真实报文，不会变成空白
- **入场动画不依赖 IntersectionObserver**：改为自己算位置 + 5 秒全局兜底，锚点跳转不会出现空白区块
- **全局错误边界**：任何未捕获错误都会显示在页面上，而不是静默失败
- **后端不可达时**：演示区降级为提示，其余板块照常可用

> ⚠️ 沙箱模式下的「模拟支付」由服务端代劳买方动作（仅沙箱可用，正式环境接口直接返回 403）。
> 它走的是真实沙箱收银接口，只是把 Agent 的动作省掉了，方便现场演示。

### 更新协议快照

改动支付链路后重新抓一次真实报文：

```bash
node scripts/capture-protocol-trace.js
```

---

## 快速开始

```bash
npm install

# 1) 准备沙箱（见下方「沙箱初始化」）
npm run dev

# 2) 体验 402 支付挑战
curl -i "http://localhost:3000/api/v1/guide?scene=demo-park&query=从南门到图书馆怎么走"
# → HTTP 402 + Payment-Needed 头

# 3) 场景目录 / 订单看板
curl http://localhost:3000/api/v1/scenes
curl http://localhost:3000/api/v1/stats
```

### 沙箱初始化

官方 Skill 提供匿名沙箱能力，**不需要支付宝账号**：

```bash
# 安装官方 Skill（含 alipay-cli）
npx -y @alipay/alipay-aipay@latest install
export PATH="$HOME/.local/bin:$PATH"

# 创建匿名沙箱
alipay-cli mcp call alipay-anonymous-sandbox.createAnonymousSandbox \
  --data '{"request":{"appType":"PUBLICAPP"}}' --json
```

把返回的 `data` 落到项目根目录 `.alipay-sandbox.json`（权限 0600，已在 `.gitignore` 中），字段含义：

| 字段 | 用途 |
|---|---|
| `appIds[0].appId` | 沙箱应用 ID |
| `appIds[0].alipayPublicKey` | 支付宝公钥（base64 DER SPKI） |
| `appIds[0].appPrivatePkcsKey` | **应用私钥（PKCS#1）—— Node 用这个** |
| `appIds[0].appPrivateKey` | 应用私钥（PKCS#8）—— Java 用这个 |
| `appIds[0].pid` | **商户 PID（2088 格式）= `seller_id`** |
| `sandboxAccounts.user.userId` | 沙箱买家 2088 账号（联调脚本用） |
| `sandboxAccounts.partner.userId` | 沙箱商家 2088 账号 |

### 官方端到端联调

```bash
SKILL=~/.claude/skills/alipay-aipay
node "$SKILL/references/normal/scripts/runtime.mjs" a2m run \
  --url "http://127.0.0.1:3000/api/v1/guide?scene=demo-park&query=从南门到图书馆怎么走" \
  --method GET --buyer-id <沙箱买家2088> \
  --auto-complete --require-payment-validation \
  --agent-platform "<平台>" --session-id "<会话ID>"
```

---

## 架构

```
Agent（买方）                          商家服务（本项目）                 支付宝
     │                                       │                            │
     │ GET /api/v1/guide?query=...           │                            │
     ├──────────────────────────────────────►│ 落库订单（先落库再返回）      │
     │                                       │                            │
     │ 402 + Payment-Needed                  │ 字典序拼接 → RSA2 签名       │
     │◄──────────────────────────────────────┤ Base64URL 编码               │
     │                                       │                            │
     │ alipay-bot 402-buyer-pay ─────────────────────────────────────────►│ 沙箱收银
     │                                       │                            │
     │ 带 Payment-Proof 二次请求              │                            │
     ├──────────────────────────────────────►│                            │
     │                                       │ alipay.aipay.agent.payment.verify
     │                                       ├───────────────────────────►│
     │                                       │   ↑ client_session 原样透传 │
     │                                       │◄───────────────────────────┤
     │                                       │ 五项核验 + 幂等抢占履约      │
     │                                       │ alipay.aipay.agent.fulfillment.confirm
     │                                       ├───────────────────────────►│
     │ 200 + Payment-Validation              │                            │
     │   + 结构化导览结果                     │                            │
     │◄──────────────────────────────────────┤                            │
```

### 目录结构

```
scene-guide/
├── SKILL.md                  # 商家技能：给买方 Agent 的调用说明
├── config/services.json      # 服务档位（单价 / 额度 / serviceId）
├── scripts/smoke.js          # 离线协议自检（42 项）
└── src/
    ├── server.js             # 应用装配
    ├── config.js             # 运行时配置加载（密钥不在源码里）
    ├── a2m/
    │   ├── protocol.js       # 402 协议：签名、Base64URL、Payment-Needed/Proof/Validation
    │   └── client.js         # verify / fulfillment.confirm 封装
    ├── orders/repository.js  # SQLite 订单仓储（唯一约束 + 事务 + 幂等履约）
    ├── metering/index.js     # 自建用量计量与计费层
    ├── scene/                # 场景数据与导览内核（实体消解 / 最短路 / 证据哈希）
    └── routes/guide.js       # 付费资源路由（402 控制流）
```

---

## 三个设计要点

### 1. 先落库，再返回 402

买家付款后，支付宝会把 `out_trade_no` 带回来。服务端必须能在**验签之前**查到这笔订单，否则直接 `ORDER_NOT_FOUND`。
订单落库在返回 402 之前完成，`out_trade_no` 是唯一约束。

### 2. 幂等履约：资源只生成一次

`prepareFulfillment` 用一次原子改写（`UNFULFILLED → PENDING_CONFIRM`）抢占履约权，只有抢到的那次调用才生成资源。
并发的重复请求会复用已持久化的结果，**不会重复消耗模型算力**。
资源已生成但履约回执失败时，状态停在 `PENDING_CONFIRM`，允许携带同一笔 `Payment-Proof` 重试回执，不会重复交付。

### 3. 计量与扣费分离

平台硬约束：**服务市场注册的「服务单价」必须与实际扣费金额一致，否则用户无法支付。**
所以扣费金额恒等于档位单价，而用量在四个维度上被独立计量留痕：

| 计量项 | 单位 | 含义 |
|---|---|---|
| `guide_call` | call | 导览调用次数 |
| `tokens` | token | 模型 token 消耗 |
| `distance_m` | m | 规划路径总长度 |
| `poi_count` | poi | 返回点位数量 |

平台不提供自动 token 计量接口，**计量由商家服务端自行完成** —— 这一层是本项目里最能写进简历的工程增量。
看板：`GET /api/v1/stats`

---

## 为什么这个赛道是对的

支付宝按量付费（A2M 智能收）是**个人开发者唯一能全通的赛道**：

| 维度 | 本项目（Machine Pay） | 网页支付路径 |
|---|---|---|
| ICP 备案 | 不需要（纯 API 服务） | 需要，且备案主体 = 支付宝账号主体 |
| 营业执照 | 不需要 | JSAPI 支付强制要求 |
| 官方要求实现的接口数 | **3 个**（402 / verify / fulfill） | 6 个（下单/查询/退款/退款查询/关闭/异步通知） |
| 费率 | 1.0%，**个人开发者零费率优惠至 2026.12.31** | 0.6% |
| 结算 | 支付宝余额 | 支付宝余额 |

---

## 上线前必须替换的项

| 项 | 沙箱值 | 生产值 |
|---|---|---|
| `serviceId` | `api_mock_service_id` | **服务市场注册返回的真实 ID**（<https://b.alipay.com/page/home/open-ai-pay>） |
| `seller_id` | 沙箱 pid | 正式商户 PID（2088 格式） |
| 网关 | `openapi-sandbox.dl.alipaydev.com` | `openapi.alipay.com` |
| 密钥 | `.alipay-sandbox.json` | `config/production.json`（已 gitignore） |

`config/production.json` 若仍写着 `api_mock_service_id`，服务会**拒绝启动**。

---

## 相关文档

- [参赛方案.md](../参赛方案.md) — 赛道取舍、里程碑、简历产出
- [技术规格-A2M-402.md](../技术规格-A2M-402.md) — 协议逐字段规格与踩坑记录
- [执行清单.md](../执行清单.md) — P0→P4 可勾选清单
