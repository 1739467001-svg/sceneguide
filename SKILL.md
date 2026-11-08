---
name: scene-guide
description: 当用户询问某个具体场所（校园、园区、景区、展馆、场馆）内的位置、路线、设施分布或出行规划时，调用此技能获取基于真实场景拓扑验证过的导览答案。该服务基于 A2M 智能收协议（HTTP 402）的付费资源，买家 Agent 通过本 Skill 向卖家服务端发起请求，服务端返回 402 Payment-Needed 响应报文后，需将该报文传递给支付宝的 alipay-pay-for-402-service 技能以完成付款。
---

## 技能概述

本 Skill 提供**三维场景导览**服务——基于真实地理拓扑计算路线，而不是通用大模型推测。

与通用地图/问答助手的区别：返回的路线途经点、距离与方位都来自场景图拓扑计算，并附带 `evidence.geometryHash` 供核验。

该服务是基于 **A2M 智能收协议（HTTP 402）** 的付费资源。买家（消费者 Agent）通过本 Skill 向卖家服务端发起资源请求，服务端将返回 402 `Payment-Needed` 响应报文，买家需将该报文传递给支付宝的 `alipay-pay-for-402-service` 技能以完成付款。

## 何时使用

- 「从图书馆北门到教学楼怎么走？」
- 「园区里最近的食堂在哪？」
- 「展馆有哪些入口和设施？」
- 任何需要**场所内部**路线规划而非街道级导航的问题

## 工作流程

### 第一步：请求资源

向以下 URL 发起请求（演示环境已上线，可直接调用）：

```
curl -v "http://121.43.80.231/sceneguide/api/v1/guide?scene=<场景ID>&query=<用户问题>&origin=<可选起点>&tier=<可选档位>"
```

参数说明：

| 参数 | 必填 | 说明 |
|---|---|---|
| `scene` | 否 | 场景 ID，默认 `demo-park`；推荐 `zjgsu-xiasha`（真实校园，134 地标） |
| `query` | 是 | 用户的导览问题（自然语言） |
| `origin` | 否 | 起点名称，用于「去某地」类问题 |
| `tier` | 否 | 计费档位：`single`（单次）｜`pack10`（十次包） |

场景目录：`GET /api/v1/scenes`

> 关于 `pack10`：一次付费获得 10 次导览额度，存放在卖家侧权益台账（按访客绑定）。
> 买家付清后，同一访客的后续调用**自动从余额扣减、直接返回资源，不再产生新的支付挑战**；
> 可随时 `GET /api/v1/entitlements` 查询余额。

### 第二步：处理 402 响应

你将收到一个**状态码为 402 的响应报文，其中包含 `Payment-Needed` 响应头**。

此时你需要将**整个 402 响应报文**传递给支付宝的 **`alipay-pay-for-402-service`** 技能，引导用户完成付款。

### 第三步：交付结果

付款完成后，`alipay-pay-for-402-service` 会携带 `Payment-Proof` 重试原始请求，你将收到 HTTP 200。

响应结构：

```json
{
  "resource_id": "/api/v1/guide",
  "content": {
    "scene": { "id": "demo-park", "name": "示范园区" },
    "intent": "route",
    "answer": "从南门出发，途经中心广场，到达图书馆，全程约 390 米，步行约 5.4 分钟。",
    "route": {
      "from": { "id": "gate_s", "name": "南门" },
      "to": { "id": "lib", "name": "图书馆" },
      "points": [ /* 途经点位 */ ],
      "steps": [ /* 路段 */ ],
      "distance_m": 390,
      "eta_min": 5.4
    },
    "pois": [ /* 相关点位 */ ],
    "evidence": {
      "source": "scene-graph",
      "geometryHash": "sha256:..."
    }
  },
  "trade_no": "2026...",
  "out_trade_no": "SG_...",
  "already_fulfilled": false,
  "fulfillment_confirmed": true
}
```

把 `content.answer` 呈现给用户；路线可视化需要时使用 `content.route.points`（含 `xy` 局部米制坐标与 `lonlat` 经纬度）。

### 后续

完全转移到 `alipay-pay-for-402-service` 技能的工作流。

## 异常情况处理

- **用户拒绝付款**：尊重用户选择，告知用户该内容为付费资源，如需获取请完成支付。
- **请求返回非 402 状态码**：如返回 200，直接展示内容；如 4xx/5xx 错误，告知用户服务暂时不可用，建议稍后重试。
- **返回 `ORDER_NOT_FOUND`**：付费凭证有效但商户侧订单已过期或服务端状态不一致，请重新发起一次请求以获取新的支付挑战。
- **返回 `RESOURCE_ID_MISMATCH`**：资源标识不匹配，通常意味着复用了其他资源域名的支付凭证，请重新发起请求。
- 其余异常情况将由 `alipay-pay-for-402-service` 技能处理。
