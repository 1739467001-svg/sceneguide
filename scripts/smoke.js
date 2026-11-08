/**
 * 离线协议自检。
 *
 * 不依赖支付宝沙箱：用临时 RSA 密钥对验证「商家侧协议实现」本身是否正确：
 *   1. 场景内核：实体消解、意图识别、最短路、证据哈希
 *   2. 402 响应：状态码、Payment-Needed 头、嵌套结构、字段完整性
 *   3. 商家签名：按官方规则（字典序 + 跳过空值 + 扁平 8 字段）验签通过
 *   4. 订单持久化：先落库再返回 402；重复 out_trade_no 被唯一约束拒绝
 *   5. 计量层：三个维度的用量记录
 *
 * 用法：node scripts/smoke.js
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.js';
import { createOrderRepository } from '../src/orders/repository.js';
import { createAlipayClient } from '../src/a2m/client.js';
import { buildSignContent, base64UrlDecode } from '../src/a2m/protocol.js';
import { answerGuide, planRoute, findEntities } from '../src/scene/index.js';
import { getScene } from '../src/scene/scenes.js';

let passed = 0;
let failed = 0;

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

// ─────────────────────────────────────────────────────────────
// 1. 场景内核
// ─────────────────────────────────────────────────────────────
section('1. 场景导览内核');
const scene = getScene('demo-park');

const entities = findEntities(scene, '从南门到图书馆怎么走');
check('实体消解命中「南门」与「图书馆」', entities.length >= 2, `实际 ${entities.length}`);
check(
  '实体消解优先命中更具体的名称',
  entities[0].node.name !== '南门' || entities.length === 1,
  `首位=${entities[0]?.node.name}`,
);

const route = planRoute(scene, 'gate_s', 'lib');
check('最短路可达', route.found);
check('路线总长 = 南门→广场 260 + 广场→图书馆 130 = 390m', route.distanceM === 390, `实际 ${route.distanceM}`);
check('ETA 为正数且合理', route.etaMin > 0 && route.etaMin < 60, `实际 ${route.etaMin}`);
check('路线途经点非空', route.points.length >= 2);

const guide = answerGuide({ sceneId: 'demo-park', query: '从南门到图书馆怎么走' });
check('导览回答成功', guide.ok === true);
check('导览意图识别为 route', guide.intent === 'route', `实际 ${guide.intent}`);
check('导览回答含距离与步行时间', /390\s*米/.test(guide.answer) && /分钟/.test(guide.answer));
check('证据哈希存在', /^sha256:[0-9a-f]{32}$/.test(guide.evidence?.geometryHash ?? ''));

const poiGuide = answerGuide({ sceneId: 'demo-park', query: '食堂在哪里' });
check('单点查询意图为 poi', poiGuide.intent === 'poi', `实际 ${poiGuide.intent}`);

const unknown = answerGuide({ sceneId: 'no-such-scene', query: 'x' });
check('未知场景被拒绝', unknown.ok === false && unknown.error === 'SCENE_NOT_FOUND');

// ─────────────────────────────────────────────────────────────
// 2. 商家签名与 402 响应
// ─────────────────────────────────────────────────────────────
section('2. A2M 402 协议与商家签名');

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const privateKeyB64 = privateKey.export({ type: 'pkcs1', format: 'der' }).toString('base64');
const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scene-guide-smoke-'));
const dbFile = path.join(tmpDir, 'orders.db');
const repository = createOrderRepository({ file: dbFile });

const config = {
  env: 'sandbox',
  appId: '2021000000000000',
  alipayPublicKey: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A...FAKE',
  privateKeyB64,
  buyerUserId: '2088000000000000',
  gateway: 'https://openapi-sandbox.dl.alipaydev.com/gateway.do',
};
const services = {
  single: { serviceId: 'api_mock_service_id', unitPrice: '0.01', quota: 1, label: '单次导览' },
};
const alipayClient = createAlipayClient(config);
const app = createApp({
  config,
  services,
  sellerId: '2088123456789012',
  repository,
  alipayClient,
});

const server = app.listen(0);
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const first = await fetch(`${base}/api/v1/guide?scene=demo-park&query=${encodeURIComponent('从南门到图书馆怎么走')}`);
check('首次请求返回 402', first.status === 402, `实际 ${first.status}`);

const paymentNeededRaw = first.headers.get('payment-needed');
check('响应包含 Payment-Needed 头', Boolean(paymentNeededRaw));

const payload = JSON.parse(base64UrlDecode(paymentNeededRaw));
check('载荷是 protocol/method 嵌套结构', Boolean(payload.protocol) && Boolean(payload.method));
check(
  'protocol 含 8 个必备字段',
  ['out_trade_no', 'amount', 'currency', 'resource_id', 'pay_before', 'seller_signature', 'seller_sign_type', 'seller_unique_id'].every(
    (k) => k in payload.protocol,
  ),
  Object.keys(payload.protocol ?? {}).join(','),
);
check('method 含 6 个必备字段',
  ['seller_name', 'seller_id', 'seller_app_id', 'goods_name', 'seller_unique_id_key', 'service_id'].every(
    (k) => k in payload.method,
  ),
  Object.keys(payload.method ?? {}).join(','),
);
check('seller_sign_type 为 RSA2', payload.protocol.seller_sign_type === 'RSA2');
check('金额单位是元且保留两位', payload.protocol.amount === '0.01', payload.protocol.amount);
check('pay_before 为 ISO 8601 带时区', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/.test(payload.protocol.pay_before));

// 商家签名验算：按官方规则取扁平 8 字段拼接
const signedFields = {
  amount: payload.protocol.amount,
  currency: payload.protocol.currency,
  goods_name: payload.method.goods_name,
  out_trade_no: payload.protocol.out_trade_no,
  pay_before: payload.protocol.pay_before,
  resource_id: payload.protocol.resource_id,
  seller_id: payload.method.seller_id,
  service_id: payload.method.service_id,
};
const signContent = buildSignContent(signedFields);
const verified = crypto
  .createVerify('RSA-SHA256')
  .update(signContent, 'utf8')
  .verify(publicKeyPem, Buffer.from(payload.protocol.seller_signature, 'base64'));
check('商家签名验签通过（字典序 + 跳过空值 + 扁平 8 字段）', verified);
check('签名内容不含 seller_signature 自身', !signContent.includes('seller_signature'));

const body = await first.json();
check('402 响应体含 code=Payment-Needed', body.code === 'Payment-Needed');
check('402 响应体含 out_trade_no 与金额', Boolean(body.out_trade_no) && body.amount === '0.01');

// ─────────────────────────────────────────────────────────────
// 3. 订单持久化与幂等
// ─────────────────────────────────────────────────────────────
section('3. 订单持久化与幂等');
const stored = await repository.findByOutTradeNo(body.out_trade_no);
check('402 返回前订单已落库', Boolean(stored));
check('订单初始状态 PENDING_PAYMENT / UNFULFILLED',
  stored.orderStatus === 'PENDING_PAYMENT' && stored.fulfillStatus === 'UNFULFILLED');
check('订单记录的 resource_id 与载荷一致', stored.resourceId === payload.protocol.resource_id);
check('订单记录的金额与载荷一致', stored.amount === payload.protocol.amount);

let uniqueRejected = false;
try {
  await repository.createPending({
    outTradeNo: body.out_trade_no,
    amount: '0.01',
    currency: 'CNY',
    resourceId: payload.protocol.resource_id,
    goodsName: 'dup',
    tier: 'single',
    payBefore: payload.protocol.pay_before,
  });
} catch {
  uniqueRejected = true;
}
check('重复 out_trade_no 被唯一约束拒绝', uniqueRejected);

const missing = await repository.findByOutTradeNo('SG_DOES_NOT_EXIST');
check('查不存在的订单返回 null', missing === null);

// ─────────────────────────────────────────────────────────────
// 4. 幂等履约
// ─────────────────────────────────────────────────────────────
section('4. 幂等履约');
let resourceBuildCount = 0;
const fulfillment1 = await repository.prepareFulfillment({
  outTradeNo: body.out_trade_no,
  tradeNo: '20260000000000000000000000000001',
  expectedAmount: '0.01',
  expectedResourceId: payload.protocol.resource_id,
  createResource: async () => {
    resourceBuildCount += 1;
    return { serviceResult: { answer: 'x' }, usage: [{ meter: 'guide_call', quantity: 1, unit: 'call' }] };
  },
});
check('首次履约抢占成功', fulfillment1.state === 'PENDING_CONFIRM');

const fulfillment2 = await repository.prepareFulfillment({
  outTradeNo: body.out_trade_no,
  tradeNo: '20260000000000000000000000000001',
  expectedAmount: '0.01',
  expectedResourceId: payload.protocol.resource_id,
  createResource: async () => {
    resourceBuildCount += 1;
    return { serviceResult: { answer: 'y' }, usage: [] };
  },
});
check('重复履约不再生成资源', resourceBuildCount === 1, `实际生成 ${resourceBuildCount} 次`);
check('重复履约复用已持久化结果', fulfillment2.serviceResult.answer === 'x');

await repository.markFulfilled(body.out_trade_no, '20260000000000000000000000000001');
const fulfilled = await repository.findByOutTradeNo(body.out_trade_no);
check('履约完成后状态为 PAID / FULFILLED',
  fulfilled.orderStatus === 'PAID' && fulfilled.fulfillStatus === 'FULFILLED');

const usage = repository.listUsage(body.out_trade_no);
check('用量明细已记录', usage.length === 1 && usage[0].meter === 'guide_call');

// ─────────────────────────────────────────────────────────────
// 5. 验签失败路径（无真实沙箱凭证）
// ─────────────────────────────────────────────────────────────
section('5. 凭证无效时的回退行为');
const badProof = Buffer.from(
  JSON.stringify({
    protocol: { payment_proof: 'invalid-proof', trade_no: '20260000000000000000000000000002' },
    method: { client_session: 'invalid-session' },
  }),
).toString('base64url');

const second = await fetch(`${base}/api/v1/guide?scene=demo-park&query=test`, {
  headers: { 'Payment-Proof': badProof },
});
const secondText = await second.text();
check('无效凭证不返回 200', second.status !== 200, `实际 ${second.status}`);
check('无效凭证不泄露资源内容', !secondText.includes('"answer"'));
check(
  '无效凭证返回明确的失败码',
  /VERIFY_FAILED|INVALID_PAYMENT_PROOF|Payment-Needed/.test(secondText),
  secondText.slice(0, 160),
);

// ─────────────────────────────────────────────────────────────
// 6. 辅助接口
// ─────────────────────────────────────────────────────────────
section('6. 场景目录与订单看板');
const scenesRes = await fetch(`${base}/api/v1/scenes`);
const scenesJson = await scenesRes.json();
check('场景目录可访问', Array.isArray(scenesJson.scenes) && scenesJson.scenes.length >= 1);

const statsRes = await fetch(`${base}/api/v1/stats`);
const stats = await statsRes.json();
check('订单看板可访问', typeof stats.orders === 'number' && typeof stats.revenueCny === 'number');
check('看板统计到已支付订单', stats.paid === 1, `实际 ${stats.paid}`);

const health = await fetch(`${base}/healthz`);
check('健康检查通过', (await health.json()).ok === true);

server.close();
repository.close();
fs.rmSync(tmpDir, { recursive: true, force: true });

console.log(`\n${'─'.repeat(52)}`);
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
process.exit(failed === 0 ? 0 : 1);
