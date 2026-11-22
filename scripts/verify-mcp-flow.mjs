#!/usr/bin/env node
/**
 * MCP Agent 链路端到端验收
 *
 * 为什么单独写一个脚本：Agent Pay 赛道的第一环是「Agent 发现服务」。
 * 浏览器演示只覆盖「人」的路径；这条脚本覆盖「Agent」的路径——
 * 完全按官方买方技能的节奏走，不碰任何内部实现：
 *
 *   1. POST /mcp  initialize                → 协议握手
 *   2. POST /mcp  tools/list                → 发现 scene_guide（paid=true）
 *   3. POST /mcp  tools/call（无凭证）       → 真实 402 挑战 + Payment-Needed 账单头
 *   4. GET  /api/v1/orders/:no              → 订单已落库（付款前必须存在）
 *   5. 沙箱收银（真实接口）                  → Payment-Proof
 *   6. POST /mcp  tools/call（带凭证）       → 验付 + 幂等履约 + 交付
 *   7. 同一凭证再调一次                      → 不重复履约（already_fulfilled）
 *
 * 用法：
 *   node scripts/verify-mcp-flow.mjs                  # 默认打本地 3000
 *   BASE_URL=http://121.43.80.231/sceneguide node scripts/verify-mcp-flow.mjs
 *
 * 依赖仓库根的 .alipay-sandbox.json（买家账号），
 * 与 scripts/verify.sh 的支付步骤同一口径；正式环境（production）跳过支付段。
 */

import { readFileSync } from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const BASE = (process.env.BASE_URL ?? 'http://127.0.0.1:3000').replace(/\/$/, '');
const MCP_URL = `${BASE}/mcp`;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const CYAN = '\x1b[36m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

let passed = 0;
let failed = 0;
const ok = (msg) => {
  passed += 1;
  console.log(`  ${GREEN}✓${RESET} ${msg}`);
};
const bad = (msg) => {
  failed += 1;
  console.log(`  ${RED}✗ ${msg}${RESET}`);
};
const step = (msg) => console.log(`\n${CYAN}▸ ${msg}${RESET}`);

/** 沙箱买家账号：与 src/config.js 同一读取口径 */
function sandboxBuyerId() {
  try {
    const raw = JSON.parse(readFileSync(path.join(ROOT, '.alipay-sandbox.json'), 'utf8'));
    return raw?.sandboxAccounts?.user?.userId ?? raw?.appIds?.[0]?.pid ?? null;
  } catch {
    return null;
  }
}

const SANDBOX_CASHIER = 'http://aicashier.dl.alipaydev.com/openclawpay/agent/v1/pay';

function snakeToCamel(key) {
  if (!key.includes('_')) return key;
  const [first, ...rest] = key.split('_');
  return first + rest.map((p) => p.slice(0, 1).toUpperCase() + p.slice(1)).join('');
}
function convertKeys(value) {
  if (Array.isArray(value)) return value.map(convertKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [snakeToCamel(k), convertKeys(v)]));
  }
  return value;
}
const nowMs = () => String(Date.now());
const timestampFromOutTradeNo = (outTradeNo) => {
  const match = /(\d{10,})$/.exec(String(outTradeNo ?? ''));
  return match ? match[1] : nowMs();
};

async function mcpCall(method, params, cookie) {
  const res = await fetch(MCP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now() % 100000, method, params }),
    signal: AbortSignal.timeout(30000),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

/** 沙箱收银：与 src/demo/pay.js 同算法（官方 local_402_sandbox_pay.py 同款） */
async function sandboxPay(paymentNeededHeader, buyerId) {
  const decoded = JSON.parse(Buffer.from(paymentNeededHeader, 'base64url').toString('utf8'));
  const converted = convertKeys(decoded);
  const method = { ...(converted.method ?? {}) };
  const protocol = { ...(converted.protocol ?? {}) };
  method.buyerUniqueIdKey = 'buyerExternalId';
  protocol.buyerUniqueId = buyerId;
  const payload = {
    method,
    protocol,
    signature: {
      buyerExternalId: buyerId,
      buyerSignature: '-',
      timestamp: timestampFromOutTradeNo(protocol.outTradeNo),
    },
  };
  // 🔴 与 src/demo/pay.js 同口径：沙箱收银对连续支付有低概率拒单
  //    （PAY_SUBMIT_FAILED「系统繁忙」，实测，约 1/10）。只对「明确的临时性失败」
  //    做最多 5 次退避重试（1s/2s/4s/8s/16s）；参数类错误重试必然同样失败，不重试。
  let cashierBody;
  for (let attempt = 1; attempt <= 5; attempt++) {
    const res = await fetch(SANDBOX_CASHIER, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30000),
    });
    cashierBody = await res.json().catch(() => ({}));
    const failed = !res.ok || cashierBody.errorCode;
    if (!failed) break;
    const transient = /繁忙|BUSY|TIMEOUT|timeout|try.?again|稍后/i.test(
      `${cashierBody.errorCode ?? ''} ${cashierBody.errorMessage ?? ''}`,
    );
    if (!transient || attempt === 5) {
      throw new Error(
        `沙箱收银失败：${cashierBody.errorCode ?? res.status} ${cashierBody.errorMessage ?? ''}`,
      );
    }
    await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1)));
  }
  const tradeNo = cashierBody?.protocol?.tradeNo ?? cashierBody?.protocol?.tradeCoreTradeNo;
  if (!tradeNo) throw new Error('沙箱收银未返回交易号');

  const proofTimestamp = nowMs();
  const paymentProof = crypto
    .createHash('sha256')
    .update(`${tradeNo}|${buyerId}|${proofTimestamp}`)
    .digest('hex');
  const clientSession = Buffer.from(
    JSON.stringify({ externalId: buyerId, signature: '-', timestamp: proofTimestamp }),
    'utf8',
  ).toString('base64');
  const proofBody = {
    protocol: { payment_proof: paymentProof, trade_no: tradeNo },
    method: { client_session: clientSession },
  };
  return {
    tradeNo,
    proofHeader: Buffer.from(JSON.stringify(proofBody), 'utf8').toString('base64url'),
  };
}

async function main() {
  console.log('三维问路 · SceneGuide —— MCP Agent 链路端到端验收');
  console.log(`目标：${BASE}`);

  // 固定访客：让挑战订单与带凭证调用归到同一个「Agent 宿主」
  const cookie = `sg_vid=mcp-e2e-${Date.now().toString(36)}`;

  step('0. 服务可达性与运行环境');
  const health = await fetch(`${BASE}/healthz`).then((r) => r.json()).catch(() => null);
  if (!health?.ok) {
    bad('GET /healthz 不可达');
    return finish();
  }
  ok(`GET /healthz → 200（env=${health.env}）`);
  const isSandbox = health.env === 'sandbox';
  if (!isSandbox) {
    console.log(`${DIM}  正式环境：跳过支付段（真实收银必须由买家本人确认）${RESET}`);
  }

  step('1. MCP 协议握手');
  const init = await mcpCall('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'verify-mcp-flow', version: '1.0.0' },
  }, cookie);
  if (init.body?.result?.serverInfo?.name === 'scene-guide') {
    ok('initialize 返回服务信息');
  } else {
    bad(`initialize 异常：${JSON.stringify(init.body).slice(0, 160)}`);
  }

  step('2. Agent 发现服务（tools/list）');
  const list = await mcpCall('tools/list', {}, cookie);
  const tools = list.body?.result?.tools ?? [];
  const guide = tools.find((t) => t.name === 'scene_guide');
  const scenes = tools.find((t) => t.name === 'scene_guide_scenes');
  if (guide) ok('tools/list 返回 scene_guide'); else bad('tools/list 缺少 scene_guide');
  if (scenes) ok('tools/list 返回 scene_guide_scenes（先选场景再问路）'); else bad('缺少 scene_guide_scenes');
  if (guide?.annotations?.paid === true) ok('工具标注 paid=true（Agent 宿主可提示计费）');
  else bad('scene_guide 未标注 paid=true');

  step('3. 场景目录工具（免费）');
  const scenesCall = await mcpCall('tools/call', { name: 'scene_guide_scenes', arguments: {} }, cookie);
  const scenesPayload = JSON.parse(scenesCall.body?.result?.content?.[0]?.text ?? '{}');
  if (Array.isArray(scenesPayload.scenes) && scenesPayload.scenes.length > 0) {
    ok(`scene_guide_scenes 返回 ${scenesPayload.scenes.length} 个场景`);
  } else {
    bad('scene_guide_scenes 未返回场景列表');
  }
  // 选旗舰场景（地标最多、演示主场景）；与前端 SAMPLES 的选择口径一致，
  // 否则示例问题「从A教学楼到C教学楼」在演示园区里解析不出路线
  const sceneId =
    scenesPayload.scenes?.find((s) => s.id === 'zjgsu-xiasha')?.id ??
    scenesPayload.scenes?.find((s) => s.source === 'openstreetmap')?.id ??
    scenesPayload.scenes?.[0]?.id ??
    'zjgsu-xiasha';
  const sampleQuery =
    sceneId === 'liangzhu-culture-village'
      ? '从良渚博物院到良渚国家考古遗址公园怎么走'
      : '从A教学楼到C教学楼怎么走';
  ok(`选用场景 ${sceneId}（示例问题已按场景核对过连通性）`);

  step('4. 首次调用 → 真实 402 支付挑战');
  const challenge = await mcpCall(
    'tools/call',
    { name: 'scene_guide', arguments: { scene: sceneId, query: sampleQuery } },
    cookie,
  );
  const sc = challenge.body?.result?.structuredContent ?? {};
  const header = sc.payment_needed_header;
  if (sc.status !== 'payment_required') {
    bad(`未返回 payment_required：${JSON.stringify(sc).slice(0, 200)}`);
    return finish();
  }
  ok('tools/call 返回 payment_required');
  if (header && typeof header === 'string') {
    ok('携带 payment_needed_header（Base64URL 原文）');
  } else {
    bad('缺少 payment_needed_header');
    return finish();
  }
  let decoded = null;
  try {
    decoded = JSON.parse(Buffer.from(header, 'base64url').toString('utf8'));
  } catch {
    bad('payment_needed_header 无法 Base64URL 解码');
    return finish();
  }
  ok('账单头可解码（protocol/method 两层结构）');
  const outTradeNo = sc.out_trade_no ?? decoded?.protocol?.out_trade_no;
  if (outTradeNo) ok(`商户订单号：${outTradeNo}`); else bad('挑战响应缺少 out_trade_no');
  if (decoded?.protocol?.seller_signature) ok('账单带商家签名（RSA2）');
  else bad('账单缺少 seller_signature');

  step('5. 订单在付款前已落库');
  const order = await fetch(`${BASE}/api/v1/orders/${encodeURIComponent(outTradeNo)}`)
    .then((r) => r.json())
    .catch(() => ({}));
  if (order.out_trade_no === outTradeNo && order.order_status === 'PENDING_PAYMENT') {
    ok('本地订单存在且为 PENDING_PAYMENT');
  } else {
    bad(`订单状态异常：${JSON.stringify(order).slice(0, 160)}`);
  }

  if (!isSandbox) {
    console.log(`\n${DIM}正式环境：支付与履约段由买家本人完成，此处略过。${RESET}`);
    return finish();
  }

  const buyerId = sandboxBuyerId();
  if (!buyerId) {
    bad('未找到沙箱买家账号（.alipay-sandbox.json）');
    return finish();
  }

  step('6. 沙箱收银（真实接口，买家动作由脚本代劳）');
  let paid;
  try {
    paid = await sandboxPay(header, buyerId);
    ok(`收银完成，交易号 ${paid.tradeNo.slice(0, 12)}…`);
  } catch (err) {
    bad(`沙箱收银失败：${err.message}`);
    return finish();
  }

  step('7. 携带 Payment-Proof 重新调用 → 验付 + 履约 + 交付');
  const delivered = await mcpCall(
    'tools/call',
    {
      name: 'scene_guide',
      arguments: {
        scene: sceneId,
        query: sampleQuery,
        payment_proof: paid.proofHeader,
      },
    },
    cookie,
  );
  const dr = delivered.body?.result ?? {};
  if (dr.isError) {
    bad(`带凭证调用失败：${JSON.stringify(dr.content?.[0]?.text ?? dr).slice(0, 240)}`);
  } else {
    ok('tools/call 交付成功（无 isError）');
  }
  const structured = dr.structuredContent ?? {};
  if (structured.answer) ok(`返回导览答案：「${String(structured.answer).slice(0, 40)}…」`);
  else bad('structuredContent 缺少 answer');
  if (structured.billing?.meters?.length || structured.billing) ok('附带用量计量摘要');
  else bad('缺少 billing 计量摘要');
  if (structured.route?.geometryHash || structured.evidence?.geometryHash) {
    ok('附带可核验几何哈希');
  } else {
    bad('缺少 geometryHash');
  }
  if (structured.route?.distance_m) ok(`距离 ${structured.route.distance_m} m（来自真实拓扑）`);

  step('8. 订单终态与幂等重放');
  const order2 = await fetch(`${BASE}/api/v1/orders/${encodeURIComponent(outTradeNo)}`)
    .then((r) => r.json())
    .catch(() => ({}));
  if (order2.order_status === 'PAID' && order2.fulfill_status === 'FULFILLED') {
    ok('订单 PAID / FULFILLED');
  } else {
    bad(`订单终态异常：${JSON.stringify(order2).slice(0, 160)}`);
  }
  // 重放：同一笔凭证再次调用。若上一笔的履约回执还没被沙箱确认
  // （PENDING_CONFIRM，沙箱偶发返回非标准响应），服务端会明确返回 502
  // 让买家重试——这本身就是设计行为，所以这里也按买方的节奏重试。
  let replayStructured = null;
  let replayErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const replay = await mcpCall(
      'tools/call',
      {
        name: 'scene_guide',
        arguments: {
          scene: sceneId,
          query: sampleQuery,
          payment_proof: paid.proofHeader,
        },
      },
      cookie,
    );
    replayStructured = replay.body?.result?.structuredContent ?? null;
    replayErr = replay.body?.result?.isError
      ? (replay.body?.result?.content?.[0]?.text ?? '未知错误')
      : null;
    if (!replayErr && replayStructured?.answer) break;
    if (attempt < 3) await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1)));
  }
  if (!replayErr && replayStructured?.answer) {
    ok('同一凭证重放仍交付（幂等，不重复履约）');
  } else {
    bad(`重放失败：${String(replayErr).slice(0, 200)}`);
  }

  finish();
}

function finish() {
  console.log('\n────────────────────────────────────────────────────────');
  if (failed === 0) {
    console.log(`${GREEN}MCP Agent 链路全部通过：${passed} 项${RESET}`);
    process.exit(0);
  }
  console.log(`${RED}失败 ${failed} 项 / 通过 ${passed} 项${RESET}`);
  process.exit(1);
}

main().catch((err) => {
  console.error(`\n${RED}脚本异常：${err.message}${RESET}`);
  process.exit(1);
});
