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
import { createQuest } from '../src/scene/quest.js';
import { finishedUnderTime } from '../src/orders/repository.js';
import { measure, billingSummary } from '../src/metering/index.js';
import { loadServices } from '../src/config.js';
import { createAnalyticsStore } from '../src/analytics/store.js';
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

// ── 1b. 2026-11-21 内核修复的回归用例（全部为实测复现过的缺陷）────────
//  H1/H4 重复与空串打卡点会让**已付费**的任务永久卡死；
//  H3 折线缺起点（三维演示的直接视觉缺陷 + 文案漏途经点 + 哈希不覆盖起点）；
//  H2 同类地标被配成起终点（「从41号学生公寓到38号学生公寓」）；
//  L1 组合方位语序（「南西侧」）；L4 未命中时甩目录而不说没找到。
section('1b. 内核边界与修复回归');
const CAMPUS = 'zjgsu-xiasha';

const dupQuest = createQuest({ sceneId: CAMPUS, checkpointNames: ['图书馆', '图书馆'] });
check('H1 重复打卡点被拒（否则任务永久卡死）', dupQuest.ok === false, dupQuest.error ?? '');

const trailQuest = createQuest({ sceneId: CAMPUS, checkpointNames: ['图书馆', ''] });
check('H4 空串/尾随逗号不产生幽灵打卡点', trailQuest.ok === false, trailQuest.error ?? '');

const oneQuest = createQuest({ sceneId: CAMPUS, checkpointNames: ['图书馆'] });
check('H1 只点名 1 个打卡点时显式报错', oneQuest.ok === false, oneQuest.error ?? '');

const autoQuest = createQuest({ sceneId: CAMPUS, checkpointNames: [] });
const autoIds = (autoQuest.quest?.clues ?? []).map((c) => c.hint);
check(
  'H1 自动任务的打卡点互不相同',
  autoQuest.ok === true && new Set(autoIds).size === autoIds.length,
  `站点数=${autoIds.length}`,
);
check(
  'M1 线索按站对齐：首条线索描述起点方位',
  /起点是/.test(autoQuest.quest?.clues?.[0]?.text ?? ''),
  (autoQuest.quest?.clues?.[0]?.text ?? '').slice(0, 40),
);

const campusRoute = answerGuide({ sceneId: CAMPUS, query: '从A教学楼到C教学楼怎么走' });
const poly = campusRoute.route?.polyline ?? [];
check('H3 折线包含起点节点（点数 ≥ 跳数）', poly.length >= 2 && poly[0] !== undefined, `首点=${JSON.stringify(poly[0])}`);
check(
  'H3 起终点与路线首末一致',
  poly.length >= 2 &&
    Math.abs(poly[0][0] - (campusRoute.route?.from?.xy?.[0] ?? -1)) < 1e-6,
  `from=${JSON.stringify(campusRoute.route?.from?.xy)} poly0=${JSON.stringify(poly[0])}`,
);

const canteen = answerGuide({ sceneId: CAMPUS, query: '怎么去食堂' });
check(
  'H2 只提一类地标时回问起点，不生成同类互穿的路线',
  /告诉我|哪一个/.test(canteen.answer) && !/从.*到.*米/.test(canteen.answer),
  canteen.answer.slice(0, 50),
);

const dorms = answerGuide({ sceneId: CAMPUS, query: '怎么去学生公寓' });
check(
  'H2 同类地标报出数量并追问',
  /个「学生公寓」/.test(dorms.answer),
  dorms.answer.slice(0, 50),
);

const canteenPoi = answerGuide({ sceneId: CAMPUS, query: '食堂在哪' });
check(
  'M3 同名地标全部列出（3 个食堂不折叠成 1 个）',
  (canteenPoi.pois ?? []).length >= 2,
  `pois=${(canteenPoi.pois ?? []).length}`,
);
check('L1 组合方位用标准语序（不出现「南西/北东」）', !/南西|北东|南东|北西/.test(canteenPoi.answer), canteenPoi.answer.slice(0, 60));

const miss = answerGuide({ sceneId: CAMPUS, query: '怎么去体育馆' });
check('L4 未命中地标时先说明没找到', /没有在.*找到/.test(miss.answer), miss.answer.slice(0, 40));

const samePoint = answerGuide({ sceneId: CAMPUS, query: '到图书馆怎么走', originHint: '图书馆' });
check(
  'M4 起终点相同时的话术不自相矛盾',
  /你已在该地点/.test(samePoint.answer) && !/没有在.*找到/.test(samePoint.answer),
  samePoint.answer.slice(0, 40),
);

const direction = answerGuide({ sceneId: CAMPUS, query: '图书馆 教学楼 怎么走' });
check(
  'M5 无句式时按出现顺序定方向（先说图书馆则以图书馆为起点）',
  /从浙江工商大学图书馆到/.test(direction.answer),
  direction.answer.slice(0, 40),
);

// 评分真实性：under_time 必须真的看时间（旧实现无条件发加分，证书恒 150）
const questForScore = createQuest({ sceneId: CAMPUS, checkpointNames: [] }).quest;
const baseScore = questForScore.scoring.base;
const fastCheckins = questForScore.checkpoints.map((c, i) => ({
  point_id: c.id,
  checked_at: new Date(Date.now() + i * 30000).toISOString(), // 每站 30 秒，远低于预估
}));
const slowCheckins = questForScore.checkpoints.map((c, i) => ({
  point_id: c.id,
  checked_at: new Date(Date.now() + i * 3600_000).toISOString(), // 每站 1 小时，远超预估
}));
check(
  'M2 快速完成拿到时间加分',
  finishedUnderTime({ ...questForScore, checkins: fastCheckins }) === true,
);
check(
  'M2 超时完成拿不到时间加分（旧实现无条件发）',
  finishedUnderTime({ ...questForScore, checkins: slowCheckins }) === false,
);
check('M2 基础分存在且加分项含时间项', baseScore > 0 && questForScore.scoring.bonuses.some((b) => b.key === 'under_time'));

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

// ─────────────────────────────────────────────────────────────
// 7. 数据诚信与计量口径（2026-11-21 增长层 review 的回归）
//    这一节全在临时库上跑，不动上面的服务实例。
// ─────────────────────────────────────────────────────────────
section('7. 数据诚信与计量口径');

// M1：token 公式不能把 answer 双算（评审要能复算「(JSON 字符数)/2」）
const measureResult = { answer: '从A教学楼到C教学楼，全程约 142 米。', route: { distance_m: 142 } };
const measureRows = measure(measureResult);
const tokenRow = measureRows.find((r) => r.meter === 'tokens');
const expectedTokens = Math.ceil(JSON.stringify(measureResult).length / 2);
check(
  'M1 token = ceil(交付 JSON 字符数 / 2)，answer 不被双算',
  tokenRow.quantity === expectedTokens,
  `实际 ${tokenRow.quantity}，期望 ${expectedTokens}`,
);
check(
  'M4 clue_count 有中文单位（条）而非裸英文',
  /条$/.test(billingSummary([{ meter: 'clue_count', quantity: 3, unit: 'clue' }]).clue_count),
  billingSummary([{ meter: 'clue_count', quantity: 3, unit: 'clue' }]).clue_count,
);

// H3：source 由服务端判定——markSelfTest 能把订单标为自测
const integRepo = createOrderRepository({ file: path.join(tmpDir, 'integrity.db') });
integRepo.createPending({
  outTradeNo: 'SG_INTEG_1', amount: '0.01', currency: 'CNY', resourceId: '/api/v1/guide',
  goodsName: 'x', tier: 'single', payBefore: new Date(Date.now() + 600000).toISOString(), source: 'api',
});
integRepo.attributeOrder('SG_INTEG_1', { visitorId: 'mcp-e2e-abc', refCode: null });
integRepo.markSelfTest('SG_INTEG_1');
const integOrder = await integRepo.findByOutTradeNo('SG_INTEG_1');
check('H3 服务端可把订单标记为自测（source=demo）', integOrder.source === 'demo', `实际 ${integOrder.source}`);

// H2：验收脚本访客（mcp-e2e-/acct-/verify-）不计入「真实付费」
integRepo.createPending({
  outTradeNo: 'SG_INTEG_2', amount: '0.01', currency: 'CNY', resourceId: '/api/v1/guide',
  goodsName: 'x', tier: 'single', payBefore: new Date(Date.now() + 600000).toISOString(), source: 'api',
});
integRepo.attributeOrder('SG_INTEG_2', { visitorId: 'mcp-e2e-xyz', refCode: null });
integRepo.getDb().prepare("UPDATE orders SET order_status = 'PAID', fulfill_status = 'FULFILLED' WHERE out_trade_no = ?").run('SG_INTEG_2');
const integStats = integRepo.stats();
check(
  'H2 自测访客的已付订单不计入 paidReal（旧实现每跑一次 MCP 验收就充值）',
  integStats.paid === 1 && integStats.paidReal === 0,
  `paid=${integStats.paid} paidReal=${integStats.paidReal}`,
);

// M2：退款后收入必须扣掉
integRepo.refundOrder({ outTradeNo: 'SG_INTEG_2', visitorId: 'mcp-e2e-xyz', reason: 'test' });
const afterRefund = integRepo.stats();
check(
  'M2 退款后收入减少（旧实现退款不扣收入，看板数字不动）',
  afterRefund.revenueCny === 0,
  `实际 ${afterRefund.revenueCny}`,
);

// M3：权益交付路径也落用量（旧实现只有付费路径落，看板系统性少算）
integRepo.createPending({
  outTradeNo: 'SG_PACK_1', amount: '4.50', currency: 'CNY', resourceId: '/api/v1/guide',
  goodsName: '十次导览包', tier: 'pack10', payBefore: new Date(Date.now() + 600000).toISOString(), source: 'api',
});
integRepo.grantEntitlement({ visitorId: 'pack-user', tier: 'pack10', outTradeNo: 'SG_PACK_1', quota: 10 });
const usageRows = measure({ answer: 'x', route: { distance_m: 100, points: [1, 2] } });
integRepo.recordUsage({ outTradeNo: 'SG_PACK_1', usage: usageRows });
const packUsage = integRepo.getDb().prepare('SELECT COUNT(*) AS n FROM usage_records WHERE out_trade_no = ?').get('SG_PACK_1').n;
check('M3 权益交付可落用量记录（recordUsage 两条路径共用）', packUsage === usageRows.length, `实际 ${packUsage}`);
integRepo.close();

// C1：生产环境拒绝带 mock serviceId 启动（旧防护检查的是死字段）
let prodRejected = false;
try {
  loadServices({ env: 'production' });
} catch (err) {
  prodRejected = /api_mock_service_id/.test(err.message);
}
check('C1 生产环境拒绝 mock serviceId（防止上线后每笔支付被拒单）', prodRejected);
check('沙箱环境仍接受 mock serviceId（回归）', typeof loadServices({ env: 'sandbox' }).single === 'object');

// H4：举报一人一票（同一个人点 3 次不能把反馈刷下架）
// 注意：store.listFeedback 直接返回数组；{items,total} 的包装在路由层。
const analyticsTmp = createAnalyticsStore({ file: path.join(tmpDir, 'analytics.db') });
analyticsTmp.addFeedback({ name: '测试用户', role: '游客', content: '这是一条用于举报去重测试的真实反馈。', visitorId: 'fb-author', ipHash: 'h1' });
const fbList = analyticsTmp.listFeedback('fb-author');
const fbId = fbList[0]?.id;
if (fbId) {
  const r1 = analyticsTmp.reportFeedback(fbId, 'visitor-A');
  const r2 = analyticsTmp.reportFeedback(fbId, 'visitor-A'); // 同一访客重复举报
  const r3 = analyticsTmp.reportFeedback(fbId, 'visitor-A');
  check(
    'H4 同一访客重复举报不累加（一人一票）',
    r1.reports === 1 && r2.duplicate === true && r3.reports === 1,
    `reports=${r1.reports}/${r3.reports}`,
  );
  analyticsTmp.reportFeedback(fbId, 'visitor-B');
  const r4 = analyticsTmp.reportFeedback(fbId, 'visitor-C');
  check(
    'H4 三个不同访客才触发自动隐藏',
    r4.reports === 3 && r4.status === 'HIDDEN',
    `reports=${r4.reports} status=${r4.status}`,
  );
} else {
  check('H4 举报去重（未取到反馈 id，跳过）', false);
}

repository.close();
fs.rmSync(tmpDir, { recursive: true, force: true });

console.log(`\n${'─'.repeat(52)}`);
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
process.exit(failed === 0 ? 0 : 1);
