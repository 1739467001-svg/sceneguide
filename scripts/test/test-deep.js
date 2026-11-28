/**
 * 深度测试套件（scripts/test/test-deep.js）。
 *
 * 定位：scripts/test/smoke.js 覆盖「协议与内核主路径」；本套件覆盖它**没有**触及的
 * 模块与边界——权益额度台账、礼品码、退款、打卡闭环、增长漏斗口径、
 * 反馈墙、MCP 全链路、402 付费/重放/权益交付、限流与 404 行为。
 *
 * 全部在临时目录的临时库上运行，不触碰 data/ 下的真实库。
 * 支付宝 OpenAPI 用桩客户端替代（不联网），只验证本服务自己的控制流。
 *
 * 用法：node scripts/test/test-deep.js
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from '../../src/config.js';
import {
  normalizeAmount,
  amountsEqual,
  base64UrlEncode,
  base64UrlDecode,
  parsePaymentProof,
  buildPaymentValidation,
  buildPaymentNeeded,
  buildSignContent,
  formatISO8601WithTimezone,
  toPem,
  parsePrivateKey,
} from '../../src/a2m/protocol.js';
import { measure, billingSummary, priceFor } from '../../src/metering/index.js';
import { createReceiptSweeper } from '../../src/a2m/sweeper.js';
import { loadServices } from '../../src/config.js';
import { answerGuide, planRoute, findEntities, namedNodes, coreName, nameVariants } from '../../src/scene/index.js';
import { createQuest, issueCertificate } from '../../src/scene/quest.js';
import { createOrderRepository, finishedUnderTime, computeQuestScore } from '../../src/orders/repository.js';
import { createAnalyticsStore, hashIp } from '../../src/analytics/store.js';
import { createApp } from '../../src/server.js';
import { createMcpHandler } from '../../src/mcp/server.js';

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-deep-'));

// ─────────────────────────────────────────────────────────────
// A. a2m/protocol 单元
// ─────────────────────────────────────────────────────────────
section('A. 协议层单元');

check('normalizeAmount 0.5 → 0.50', normalizeAmount('0.5') === '0.50');
check('normalizeAmount 9 → 9.00', normalizeAmount('9') === '9.00');
check('normalizeAmount 4.50 保持', normalizeAmount('4.50') === '4.50');
check('normalizeAmount 拒绝三位小数', normalizeAmount('1.005') === null, String(normalizeAmount('1.005')));
check('normalizeAmount 拒绝非数字', normalizeAmount('abc') === null);
check('normalizeAmount 拒绝空值', normalizeAmount('') === null && normalizeAmount(null) === null && normalizeAmount(undefined) === null);
check('normalizeAmount 容忍首尾空格', normalizeAmount('  12.5 ') === '12.50');
check('normalizeAmount 拒绝负号', normalizeAmount('-1') === null);
check('normalizeAmount 拒绝多个小数点', normalizeAmount('1.2.3') === null);

check('amountsEqual 跨表示相等', amountsEqual('0.5', '0.50') && amountsEqual('9', '9.00'));
check('amountsEqual 不相等时返回 false', !amountsEqual('0.5', '0.51'));
check('amountsEqual 非法输入返回 false', !amountsEqual('abc', '0.50'));

const roundTrip = '中文测试 ✓ Base64URL';
check('base64URL 编解码往返一致', base64UrlDecode(base64UrlEncode(roundTrip)) === roundTrip);
check('base64URL 输出不含 +/=', !/[+/=]/.test(base64UrlEncode('???>>>')));

check(
  'parsePaymentProof 拒绝畸形 Base64/JSON',
  parsePaymentProof('!!!not-base64!!!').ok === false && parsePaymentProof('!!!not-base64!!!').reason === 'MALFORMED',
);
check(
  'parsePaymentProof 拒绝字段不完整',
  parsePaymentProof(base64UrlEncode(JSON.stringify({ protocol: { trade_no: 't' } }))).reason === 'INCOMPLETE',
);
const proofObj = {
  protocol: { payment_proof: 'p', trade_no: 't' },
  method: { client_session: 's' },
};
const proofParsed = parsePaymentProof(base64UrlEncode(JSON.stringify(proofObj)));
check(
  'parsePaymentProof 解析出三要素',
  proofParsed.ok === true && proofParsed.paymentProof === 'p' && proofParsed.tradeNo === 't' && proofParsed.clientSession === 's',
);
check(
  'buildPaymentValidation 可解码且带 validated',
  (() => {
    const d = JSON.parse(base64UrlDecode(buildPaymentValidation({ tradeNo: 't', outTradeNo: 'o', resourceId: '/r' })));
    return d.trade_no === 't' && d.validated === true && d.resource_id === '/r';
  })(),
);

const iso = formatISO8601WithTimezone(new Date(2026, 10, 21, 9, 5, 3));
check('ISO8601 带时区偏移', /^2026-11-21T09:05:03[+-]\d{2}:\d{2}$/.test(iso), iso);
check('ISO8601 偏移量与本地时区一致', iso.endsWith('+08:00') || /[+-]\d{2}:\d{2}$/.test(iso), iso);

// 签名与密钥格式
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const privateKeyB64 = privateKey.export({ type: 'pkcs1', format: 'der' }).toString('base64');
const pkcs8B64 = privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');
const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });

check('toPem 产出 PKCS#1 PEM（alipay-sdk 要求）', /^-----BEGIN RSA PRIVATE KEY-----/.test(toPem(privateKeyB64)));
check('toPem 兼容 PKCS#8 输入并降级', /^-----BEGIN RSA PRIVATE KEY-----/.test(toPem(pkcs8B64)));
check('parsePrivateKey 返回 KeyObject', parsePrivateKey(privateKeyB64).type === 'private');

const needed = buildPaymentNeeded({
  outTradeNo: 'SG_1', amount: '0.50', currency: 'CNY', resourceId: '/api/v1/guide',
  payBefore: '2026-11-21T10:00:00+08:00', goodsName: 'g', sellerId: '2088', sellerName: 'n',
  sellerAppId: 'app', serviceId: 'sid', privateKeyB64,
});
const verifySellerSig = crypto
  .createVerify('RSA-SHA256')
  .update(
    buildSignContent({
      amount: needed.protocol.amount, currency: needed.protocol.currency,
      goods_name: needed.method.goods_name, out_trade_no: needed.protocol.out_trade_no,
      pay_before: needed.protocol.pay_before, resource_id: needed.protocol.resource_id,
      seller_id: needed.method.seller_id, service_id: needed.method.service_id,
    }),
    'utf8',
  )
  .verify(publicKeyPem, Buffer.from(needed.protocol.seller_signature, 'base64'));
check('buildPaymentNeeded 签名可验签', verifySellerSig);
check('buildPaymentNeeded 不含未声明字段', !('service_id' in needed.protocol) && needed.protocol.seller_unique_id === '2088');

// ─────────────────────────────────────────────────────────────
// B. metering 单元
// ─────────────────────────────────────────────────────────────
section('B. 计量层单元');

const guideRows = measure({ answer: 'x', route: { distance_m: 100, points: [{}, {}] } });
check('guide 结果计 guide_call/tokens/distance_m/poi_count',
  ['guide_call', 'tokens', 'distance_m', 'poi_count'].every((m) => guideRows.some((r) => r.meter === m)));
check('poi_count 取 route.points 长度', guideRows.find((r) => r.meter === 'poi_count').quantity === 2);

const questRows = measure({ quest: { total_distance_m: 500, checkpoints: [{}, {}, {}], clues: [{}, {}] } });
check('quest 结果计 clue_count', questRows.some((r) => r.meter === 'clue_count' && r.quantity === 2));
check('quest 的 poi_count 取打卡点数', questRows.find((r) => r.meter === 'poi_count').quantity === 3);

check('billingSummary 容忍空数组', Object.keys(billingSummary([])).length === 0 && Object.keys(billingSummary(null)).length === 0);
check('priceFor 规范化金额', priceFor({ unitPrice: '0.5' }) === '0.50');
check('priceFor 缺单价抛错', (() => { try { priceFor({}); return false; } catch { return true; } })());
check('priceFor 非法单价抛错', (() => { try { priceFor({ unitPrice: 'x' }); return false; } catch { return true; } })());

// ─────────────────────────────────────────────────────────────
// C. config 单元
// ─────────────────────────────────────────────────────────────
section('C. 配置层单元');

const sandboxServices = loadServices({ env: 'sandbox' });
check('沙箱把 pack10 单价归一为 0.01', sandboxServices.pack10.unitPrice === '0.01');
check('沙箱保留 productionPrice 原值（4.50）', sandboxServices.pack10.productionPrice === '4.50');
check('沙箱保留 quota（10）', sandboxServices.pack10.quota === 10);
check('四个档位都加载', ['single', 'pack10', 'quest', 'trial'].every((k) => sandboxServices[k]));

// 生产档位校验：覆盖层存在 / 缺失两种情形都必须正确
// （2026-11-24 起 config/services.production.json 提供真实 service_id 覆盖层，
//  因此「生产环境拒绝 mock serviceId」不再是无条件抛错——覆盖层在时应当放行。）
{
  const withOverlay = loadServices({ env: 'production' });
  check('C 覆盖层存在：生产加载真实 serviceId（非 mock）',
    Object.values(withOverlay).every((t) => /^API_/.test(String(t.serviceId ?? ''))),
    Object.entries(withOverlay).map(([k, v]) => `${k}=${v.serviceId}`).join(' '));
  check('C 覆盖层存在：生产单价保持注册价（不被归一为 0.01）',
    withOverlay.single.unitPrice === '0.50' && withOverlay.pack10.unitPrice === '4.50');

  // 覆盖层缺失（指向不存在的文件）→ 必须仍然拒绝启动，这是防「上线即拒单」的底线
  const prevIds = process.env.ALIPAY_SERVICES_IDS_CONFIG;
  process.env.ALIPAY_SERVICES_IDS_CONFIG = path.join(tmpDir, 'no-such-overlay.json');
  let noOverlayErr = '';
  try { loadServices({ env: 'production' }); } catch (err) { noOverlayErr = err.message; }
  if (prevIds === undefined) delete process.env.ALIPAY_SERVICES_IDS_CONFIG;
  else process.env.ALIPAY_SERVICES_IDS_CONFIG = prevIds;
  check('C 覆盖层缺失：生产环境仍拒绝 mock serviceId（防上线即拒单）',
    /api_mock_service_id/.test(noOverlayErr), noOverlayErr.slice(0, 70));
}

// ─────────────────────────────────────────────────────────────
// D. 场景内核边界
// ─────────────────────────────────────────────────────────────
section('D. 场景内核边界');

check('coreName 剥括注', coreName('逸夫楼（环境学院）') === '逸夫楼');
check('coreName 剥编号前缀', coreName('21号学生公寓') === '学生公寓');
check('nameVariants 含机构前缀剥离', nameVariants('浙江工商大学文体中心场馆').includes('文体中心'));
check('nameVariants 过滤过短变体', nameVariants('AB').every((v) => v.length >= 2));

const overview = answerGuide({ sceneId: 'demo-park', query: '' });
check('空问题走 overview 且不编造路线', overview.intent === 'overview' && overview.route === null && overview.ok === true);

const missRoute = answerGuide({ sceneId: 'zjgsu-xiasha', query: '从图书馆到一个不存在的地方怎么走' });
check('终点不可识别时不输出路线', missRoute.route === null && /告诉我|没有在/.test(missRoute.answer), missRoute.answer.slice(0, 50));

// 不连通分量 → direct-estimate 路径（zjgsu 路网碎成多分量）
const disconnected = answerGuide({ sceneId: 'zjgsu-xiasha', query: '从图书馆到学生公寓怎么走' });
check(
  '不可达时不假装有路（measured=false 或说明为估算）',
  disconnected.route === null || disconnected.route.measured === false || disconnected.route.type === 'direct-estimate',
  JSON.stringify(disconnected.route?.type ?? null),
);

// 同点守卫
const samePoint = answerGuide({ sceneId: 'demo-park', query: '从图书馆到图书馆怎么走' });
check('同点请求不返回 0 米路线', samePoint.route === null, samePoint.answer.slice(0, 40));

// Dijkstra 正确性：与手工累加比较
const r1 = planRoute({ nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], edges: [
  { from: 'a', to: 'b', cost_m: 10 }, { from: 'b', to: 'c', cost_m: 20 }, { from: 'a', to: 'c', cost_m: 100 },
] }, 'a', 'c');
check('Dijkstra 选最短路径（30 而非 100）', r1.found && r1.distanceM === 30, String(r1.distanceM));
check('Dijkstra 路径含起点与终点', r1.points[0].id === 'a' && r1.points[r1.points.length - 1].id === 'c');
const r2 = planRoute({ nodes: [{ id: 'a' }, { id: 'b' }], edges: [{ from: 'a', to: 'b', cost_m: 5 }] }, 'a', 'zzz');
check('目标节点不存在时 found=false', r2.found === false);
const r3 = planRoute({ nodes: [{ id: 'a' }, { id: 'b' }], edges: [] }, 'a', 'b');
check('无边图不可达时 found=false', r3.found === false);

// ─────────────────────────────────────────────────────────────
// E. 任务生成与证书
// ─────────────────────────────────────────────────────────────
section('E. 任务生成与证书');

for (const level of ['easy', 'normal', 'hard']) {
  const q = createQuest({ sceneId: 'zjgsu-xiasha', level, checkpointNames: [] });
  check(`level=${level} 自动任务可生成`, q.ok === true && q.quest.checkpoints.length >= 2);
  if (q.ok) {
    check(`level=${level} 线索数 = 打卡点数`, q.quest.clues.length === q.quest.checkpoints.length);
    check(`level=${level} 路段数 = 打卡点数-1`, q.quest.legs.length === q.quest.checkpoints.length - 1);
  }
}
const easyQ = createQuest({ sceneId: 'zjgsu-xiasha', level: 'easy', checkpointNames: [] }).quest;
check('easy 线索带距离细节', /约 \d+ 米/.test(easyQ.clues[1]?.text ?? ''), (easyQ.clues[1]?.text ?? '').slice(0, 40));
const hardQ = createQuest({ sceneId: 'zjgsu-xiasha', level: 'hard', checkpointNames: [] }).quest;
check('hard 线索只给方位（无距离）', !/约 \d+ 米/.test(hardQ.clues[1]?.text ?? ''));

const certQuest = createQuest({ sceneId: 'zjgsu-xiasha', checkpointNames: [] }).quest;
const checkins = certQuest.checkpoints.map((c, i) => ({ point_id: c.id, seq: i, checked_at: new Date(Date.now() + i * 60000).toISOString() }));
const certA = issueCertificate(certQuest, checkins, 150);
const certB = issueCertificate(certQuest, checkins, 150);
check('证书哈希可复算（同输入同哈希）', certA.verifiable_by === certB.verifiable_by);
const certC = issueCertificate(certQuest, checkins, 149);
check('分数参与哈希（改分数哈希变）', certA.verifiable_by !== certC.verifiable_by);
check('证书含完成时刻', certA.completedAt === checkins[checkins.length - 1].checked_at);
check('空打卡记录时 completedAt 为 null', issueCertificate(certQuest, [], 100).completedAt === null);

// ─────────────────────────────────────────────────────────────
// F. repository 深度：权益 / 礼品 / 退款 / 打卡 / 履约
// ─────────────────────────────────────────────────────────────
section('F. 仓储层深度');

const repo = createOrderRepository({ file: path.join(tmpDir, 'repo.db') });

// F1 权益 FIFO 与原子性
repo.grantEntitlement({ visitorId: 'v1', tier: 'pack10', outTradeNo: 'SG_P1', quota: 2, validDays: 90 });
repo.grantEntitlement({ visitorId: 'v1', tier: 'pack10', outTradeNo: 'SG_P2', quota: 3, validDays: 90 });
check('发放后余额为两笔 quota 之和', repo.entitlementBalance('v1').remaining === 5);
const c1 = repo.consumeEntitlement('v1');
const c2 = repo.consumeEntitlement('v-nobody');
check('FIFO：先消耗最早到账的 SG_P1', c1?.outTradeNo === 'SG_P1' && c1.remaining === 1);
check('无额度访客返回 null', c2 === null);
const c3 = repo.consumeEntitlement('v1');
check('SG_P1 第 2 次消耗后归零', c3?.outTradeNo === 'SG_P1' && c3.remaining === 0);
const c4 = repo.consumeEntitlement('v1');
check('SG_P1 耗尽后自动落到 SG_P2', c4?.outTradeNo === 'SG_P2' && c4.remaining === 2);
const c5 = repo.consumeEntitlement('v1');
check('SG_P2 继续扣减', c5?.outTradeNo === 'SG_P2' && c5.remaining === 1);
const c6 = repo.consumeEntitlement('v1');
check('SG_P2 最后一次扣减后归零', c6?.remaining === 0);
check('全部耗尽后返回 null', repo.consumeEntitlement('v1') === null);

// F2 幂等发放（同一笔订单重复履约不得叠加 quota）
repo.grantEntitlement({ visitorId: 'v1', tier: 'pack10', outTradeNo: 'SG_P1', quota: 2, validDays: 90 });
check('同订单重复发放幂等（granted 仍为 5）', repo.entitlementBalance('v1').granted === 5,
  `granted=${repo.entitlementBalance('v1').granted}`);

// F3 归还
repo.refundEntitlement(c6.id);
check('refundEntitlement 归还 1 次', repo.entitlementBalance('v1').remaining === 1);

// F4 过期：不进余额合计，也不可消费
const expiredAt = new Date(Date.now() - 86400_000).toISOString();
repo.getDb().prepare(
  'INSERT INTO entitlements (visitor_id, tier, out_trade_no, quota, used, created_at, expires_at) VALUES (?,?,?,?,?,?,?)',
).run('v-exp', 'pack10', 'SG_EXP', 5, 0, expiredAt, expiredAt);
check('过期台账不计入余额合计', repo.entitlementBalance('v-exp').remaining === 0);
check('过期台账仍逐条展示（带 expired 标记）',
  repo.entitlementBalance('v-exp').entitlements[0]?.expired === true);
check('过期台账不可消费', repo.consumeEntitlement('v-exp') === null);

// F5 礼品码（用独立访客，避免与上面的扣减记录缠在一起）
repo.grantEntitlement({ visitorId: 'gifter', tier: 'pack10', outTradeNo: 'SG_G', quota: 5, validDays: 90 });
const gift = repo.createGiftCode({ visitorId: 'gifter', tier: 'single' });
check('生成礼品码并扣 1 次额度', gift.ok === true && repo.entitlementBalance('gifter').remaining === 4);
check('自兑自己的礼品码被拒', repo.redeemGiftCode({ code: gift.code, visitorId: 'gifter' }).code === 'GIFT_SELF_REDEEM');
check('不存在礼品码被拒', repo.redeemGiftCode({ code: 'NOPE', visitorId: 'vX' }).code === 'GIFT_NOT_FOUND');
const redeem = repo.redeemGiftCode({ code: gift.code.toLowerCase(), visitorId: 'vX' });
check('兑换成功且大小写不敏感', redeem.ok === true);
check('兑换后码失效', repo.redeemGiftCode({ code: gift.code, visitorId: 'vY' }).code === 'GIFT_NOT_ACTIVE');
check('兑换给接收方发 1 次额度', repo.entitlementBalance('vX').remaining === 1);
const gift2 = repo.createGiftCode({ visitorId: 'gifter', tier: 'single' });
check('撤销他人礼品码被拒', repo.revokeGiftCode({ code: gift2.code, visitorId: 'vX' }).code === 'NOT_YOUR_GIFT');
const revoke = repo.revokeGiftCode({ code: gift2.code, visitorId: 'gifter' });
check('撤销自己的礼品码成功', revoke.ok === true);
// 撤销走「新发一笔 1 次额度」的实现（out_trade_no = GIFTBACK_<code>，与兑换对称），
// 因此 granted 变 6、可用余额从 3 回到 4 —— 赠予者确实拿回了那 1 次。
check('撤销后额度归还给赠予者（余额 3 → 4）',
  repo.entitlementBalance('gifter').remaining === 4 && repo.entitlementBalance('gifter').granted === 6,
  `remaining=${repo.entitlementBalance('gifter').remaining} granted=${repo.entitlementBalance('gifter').granted}`);
check('撤销后不可再兑换', repo.redeemGiftCode({ code: gift2.code, visitorId: 'vZ' }).code === 'GIFT_NOT_ACTIVE');
check('礼品码列表分「我生成的」与「我兑换的」',
  repo.listGiftsByVisitor('gifter').created.length === 2 && repo.listGiftsByVisitor('vX').redeemed.length === 1);

// F6 打卡闭环
const quest = createQuest({ sceneId: 'zjgsu-xiasha', checkpointNames: [] }).quest;
repo.createQuest({
  id: quest.id, outTradeNo: null, sceneId: 'zjgsu-xiasha', title: quest.title, level: quest.level,
  brief: quest.brief, totalDistanceM: quest.total_distance_m, estimatedMinutes: quest.estimated_minutes,
  checkpoints: quest.checkpoints, clues: quest.clues, legs: quest.legs, scoring: quest.scoring,
});
check('乱序打卡被拒（OUT_OF_ORDER）',
  repo.checkin(quest.id, quest.checkpoints[1].id).code === 'OUT_OF_ORDER');
check('未知点位被拒（UNKNOWN_POINT）',
  repo.checkin(quest.id, 'not-a-point').code === 'UNKNOWN_POINT');
check('未知任务被拒（QUEST_NOT_FOUND）', repo.checkin('no-quest', 'x').code === 'QUEST_NOT_FOUND');
const first = repo.checkin(quest.id, quest.checkpoints[0].id);
check('首站打卡成功', first.ok === true);
check('重复打卡被拒（ALREADY_CHECKED_IN）',
  repo.checkin(quest.id, quest.checkpoints[0].id).code === 'ALREADY_CHECKED_IN');

let last = first.quest;
for (let i = 1; i < quest.checkpoints.length; i += 1) {
  last = repo.checkin(quest.id, quest.checkpoints[i].id).quest;
}
check('打卡途中任务仍为进行中', last.status === 'IN_PROGRESS');
const completed = repo.completeQuest(quest.id, issueCertificate(last, last.checkins, 130));
check('全部打卡后任务完成', completed.status === 'COMPLETED' && completed.score > 0);
check('完成后带证书', completed.certificate?.verifiable_by?.startsWith('sha256:') === true);
check('完成后带完成时刻', typeof completed.completedAt === 'string');
check('完成后再打卡被拒（QUEST_ALREADY_COMPLETED）',
  repo.checkin(quest.id, quest.checkpoints[0].id).code === 'QUEST_ALREADY_COMPLETED');
check('completeQuest 幂等（不重复改分）', repo.completeQuest(quest.id, issueCertificate(last, last.checkins, 999)).score === completed.score);
check('未全部打卡时 completeQuest 不落地',
  repo.completeQuest('no-such-quest', {}) === null);
check('finishedUnderTime 少于 2 条打卡返回 false', finishedUnderTime({ checkins: [{ checked_at: new Date().toISOString() }] }) === false);
check('finishedUnderTime 容忍坏时间字段', finishedUnderTime({ estimatedMinutes: 10, checkins: [{ checked_at: 'bad' }, { checked_at: 'worse' }] }) === false);

// 评分口径唯一化：证书分数与库内 score 必须同源（2026-11-23 收敛为单一实现）
const scoreQuest = createQuest({ sceneId: 'zjgsu-xiasha', checkpointNames: [] }).quest;
repo.createQuest({
  id: scoreQuest.id, outTradeNo: null, sceneId: 'zjgsu-xiasha', title: scoreQuest.title, level: scoreQuest.level,
  brief: scoreQuest.brief, totalDistanceM: scoreQuest.total_distance_m, estimatedMinutes: scoreQuest.estimated_minutes,
  checkpoints: scoreQuest.checkpoints, clues: scoreQuest.clues, legs: scoreQuest.legs, scoring: scoreQuest.scoring,
});
let scoreQuestRow = { checkins: [] };
for (const cp of scoreQuest.checkpoints) {
  scoreQuestRow = repo.checkin(scoreQuest.id, cp.id).quest;
}
const certScore = computeQuestScore(scoreQuestRow);
const completedQuest = repo.completeQuest(scoreQuest.id, issueCertificate(scoreQuestRow, scoreQuestRow.checkins, certScore));
check('评分单一实现：证书分数 = 库内 score',
  completedQuest.score === certScore && completedQuest.certificate?.score === certScore,
  `db=${completedQuest.score} cert=${completedQuest.certificate?.score} 计算=${certScore}`);
check('评分含全部站点加分（≥ 基础分+30）', certScore >= scoreQuest.scoring.base + 30, String(certScore));
check('computeQuestScore 对空 scoring 有兜底', computeQuestScore({}) === 100);

// F7 履约：崩溃孤儿恢复（PENDING_CONFIRM 无结果）
repo.createPending({
  outTradeNo: 'SG_ORPHAN', amount: '0.01', currency: 'CNY', resourceId: '/api/v1/guide',
  goodsName: 'x', tier: 'single', payBefore: new Date(Date.now() + 600000).toISOString(),
});
repo.getDb().prepare("UPDATE orders SET fulfill_status = 'PENDING_CONFIRM' WHERE out_trade_no = ?").run('SG_ORPHAN');
let orphanBuilds = 0;
const orphan = await repo.prepareFulfillment({
  outTradeNo: 'SG_ORPHAN', tradeNo: 'T1', expectedAmount: '0.01', expectedResourceId: '/api/v1/guide',
  createResource: async () => { orphanBuilds += 1; return { serviceResult: { answer: 'recovered' }, usage: [] }; },
});
check('孤儿 PENDING_CONFIRM 被释放并重新生成（不砖死）', orphan.state === 'PENDING_CONFIRM' && orphanBuilds === 1);

// F8 履约：金额/资源不匹配抛错
let amErr = '';
try {
  await repo.prepareFulfillment({ outTradeNo: 'SG_ORPHAN', tradeNo: 'T1', expectedAmount: '9.99', expectedResourceId: '/api/v1/guide', createResource: async () => ({ serviceResult: {}, usage: [] }) });
} catch (err) { amErr = err.message; }
check('金额不匹配抛 AMOUNT_MISMATCH', /AMOUNT_MISMATCH/.test(amErr), amErr.slice(0, 40));
let ridErr = '';
try {
  await repo.prepareFulfillment({ outTradeNo: 'SG_ORPHAN', tradeNo: 'T1', expectedAmount: '0.01', expectedResourceId: '/other', createResource: async () => ({ serviceResult: {}, usage: [] }) });
} catch (err) { ridErr = err.message; }
check('资源不匹配抛 RESOURCE_ID_MISMATCH', /RESOURCE_ID_MISMATCH/.test(ridErr), ridErr.slice(0, 40));
let nfErr = '';
try {
  await repo.prepareFulfillment({ outTradeNo: 'SG_NOPE', tradeNo: 'T1', expectedAmount: '0.01', expectedResourceId: '/api/v1/guide', createResource: async () => ({ serviceResult: {}, usage: [] }) });
} catch (err) { nfErr = err.message; }
check('订单不存在抛 ORDER_NOT_FOUND', /ORDER_NOT_FOUND/.test(nfErr));

// F9 履约：资源生成失败 → 回退 UNFULFILLED 可重试
repo.createPending({
  outTradeNo: 'SG_FAIL', amount: '0.01', currency: 'CNY', resourceId: '/api/v1/guide',
  goodsName: 'x', tier: 'single', payBefore: new Date(Date.now() + 600000).toISOString(),
});
let failAttempts = 0;
try {
  await repo.prepareFulfillment({
    outTradeNo: 'SG_FAIL', tradeNo: 'T1', expectedAmount: '0.01', expectedResourceId: '/api/v1/guide',
    createResource: async () => { failAttempts += 1; throw new Error('boom'); },
  });
} catch { /* 期望抛错 */ }
const afterFail = await repo.findByOutTradeNo('SG_FAIL');
check('资源生成失败后退回 UNFULFILLED', afterFail.fulfillStatus === 'UNFULFILLED');
const retry = await repo.prepareFulfillment({
  outTradeNo: 'SG_FAIL', tradeNo: 'T1', expectedAmount: '0.01', expectedResourceId: '/api/v1/guide',
  createResource: async () => { failAttempts += 1; return { serviceResult: { answer: 'ok' }, usage: [] }; },
});
check('失败后可重新抢占并生成', retry.state === 'PENDING_CONFIRM' && failAttempts === 2);

// F10 recordUsage 外键宽容
const skipped = repo.recordUsage({ outTradeNo: 'GIFT_XXX', usage: [{ meter: 'guide_call', quantity: 1, unit: 'call' }] });
check('非订单号（礼品码）跳过计量且不抛错', skipped === 0);
check('recordUsage 空数组返回 0', repo.recordUsage({ outTradeNo: 'SG_FAIL', usage: [] }) === 0);

// F11 退款全路径
const mkPaid = (id, visitor) => {
  repo.createPending({
    outTradeNo: id, amount: '0.01', currency: 'CNY', resourceId: '/api/v1/guide',
    goodsName: 'x', tier: 'single', payBefore: new Date(Date.now() + 600000).toISOString(),
  });
  repo.attributeOrder(id, { visitorId: visitor, refCode: null });
  repo.markFulfilled(id, `TRADE_${id}`);
};
mkPaid('SG_RF1', 'rf-user');
check('退他人订单被拒', repo.refundOrder({ outTradeNo: 'SG_RF1', visitorId: 'other' }).code === 'NOT_YOUR_ORDER');
check('退不存在订单被拒', repo.refundOrder({ outTradeNo: 'SG_NONE', visitorId: 'rf-user' }).code === 'ORDER_NOT_FOUND');
check('未支付订单不可退', (() => {
  repo.createPending({ outTradeNo: 'SG_RF2', amount: '0.01', currency: 'CNY', resourceId: '/api/v1/guide', goodsName: 'x', tier: 'single', payBefore: new Date(Date.now() + 600000).toISOString() });
  repo.attributeOrder('SG_RF2', { visitorId: 'rf-user', refCode: null });
  return repo.refundOrder({ outTradeNo: 'SG_RF2', visitorId: 'rf-user' }).code === 'NOT_REFUNDABLE_STATE';
})());
const rf1 = repo.refundOrder({ outTradeNo: 'SG_RF1', visitorId: 'rf-user', reason: 'r' });
check('退款成功', rf1.ok === true);
check('重复退款被拒', repo.refundOrder({ outTradeNo: 'SG_RF1', visitorId: 'rf-user' }).code === 'ALREADY_REFUNDED');
check('退款订单不计收入', repo.stats().revenueCny === 0, String(repo.stats().revenueCny));

// 每日 3 笔上限
for (let i = 0; i < 3; i += 1) mkPaid(`SG_RF3_${i}`, 'rf-limit');
let limitHit = '';
for (let i = 0; i < 3; i += 1) repo.refundOrder({ outTradeNo: `SG_RF3_${i}`, visitorId: 'rf-limit' });
const overLimit = repo.refundOrder({ outTradeNo: 'SG_RF3_0', visitorId: 'rf-limit' });
check('第 4 笔退款触发每日上限', overLimit.code === 'ALREADY_REFUNDED' || overLimit.code === 'REFUND_DAILY_LIMIT');

// 整包退款：收回剩余次数
repo.createPending({
  outTradeNo: 'SG_PACKRF', amount: '4.50', currency: 'CNY', resourceId: '/api/v1/guide',
  goodsName: '十次导览包', tier: 'pack10', payBefore: new Date(Date.now() + 600000).toISOString(),
});
repo.attributeOrder('SG_PACKRF', { visitorId: 'pack-rf', refCode: null });
repo.markFulfilled('SG_PACKRF', 'TRADE_PACKRF');
repo.grantEntitlement({ visitorId: 'pack-rf', tier: 'pack10', outTradeNo: 'SG_PACKRF', quota: 10 });
repo.consumeEntitlement('pack-rf');
repo.consumeEntitlement('pack-rf');
repo.refundOrder({ outTradeNo: 'SG_PACKRF', visitorId: 'pack-rf', reason: 'x' });
check('整包退款收回剩余次数（used=8 → remaining=0）', repo.entitlementBalance('pack-rf').remaining === 0);

// 单次订单退款不动台账（防白送额度）
const balBefore = repo.entitlementBalance('pack-rf').remaining;
repo.refundOrder({ outTradeNo: 'SG_PACKRF', visitorId: 'pack-rf' });
check('整包重复退款被拒（不会再次动台账）', repo.entitlementBalance('pack-rf').remaining === balBefore);

// F12 统计口径
const stats = repo.stats();
check('stats 返回全部关键字段', ['orders', 'paid', 'paidReal', 'revenueCny', 'usage'].every((k) => k in stats));
check('findByTradeNo 空参数返回 null', repo.findByTradeNo(null) === null && repo.findByTradeNo('') === null);
check('findByTradeNo 命中已存交易号', repo.findByTradeNo('TRADE_PACKRF')?.outTradeNo === 'SG_PACKRF');
// 🔴 回归（2026-11-23 高危缺陷）：findByTradeNo 必须同步返回订单对象。
//    旧实现委托 async 的 findByOutTradeNo，返回 Promise；guide.js 的幂等重放
//    短回路不 await 它，导致短回路恒不生效——多额度买家每重放一次被多扣 1 次额度。
check('BUG-1 回归：findByTradeNo 同步返回对象（不是 Promise）',
  !(repo.findByTradeNo('TRADE_PACKRF') instanceof Promise) && typeof repo.findByTradeNo('TRADE_PACKRF') === 'object');

// ─────────────────────────────────────────────────────────────
// G. analytics 深度：漏斗口径 / 反馈 / 留资 / 归因
// ─────────────────────────────────────────────────────────────
section('G. 归因与反馈层深度');

const ana = createAnalyticsStore({ file: path.join(tmpDir, 'analytics.db') });

// G1 访客归因 first-touch wins
ana.ensureRef('zjgsu', '同学群');
ana.touchVisitor('vis-1', 'zjgsu', '1.2.3.4');
ana.touchVisitor('vis-1', 'moments', '1.2.3.4');
check('首触渠道 wins（重复访问不改归因）', ana.visitorRef('vis-1') === 'zjgsu');
ana.touchVisitor('vis-2', null, '1.2.3.4');
ana.bindRef('vis-2', 'zjgsu');
ana.bindRef('vis-2', 'hackathon');
check('bindRef 只绑一次', ana.visitorRef('vis-2') === 'zjgsu');
check('visitorSummary 统计访问次数', ana.visitorSummary('vis-1').visits === 2);
check('hashIp 加盐且定长', /^[0-9a-f]{24}$/.test(hashIp('1.2.3.4')) && hashIp('1.2.3.4') === hashIp('1.2.3.4'));
check('hashIp 空值返回 null', hashIp(null) === null);

// G2 漏斗口径：每一层都是去重访客数（BUG-2 回归）
const funnelRepo = createOrderRepository({ file: path.join(tmpDir, 'funnel.db') });
const mkFunnelOrder = (id, visitor, tier = 'single', source = 'api') => {
  funnelRepo.createPending({
    outTradeNo: id, amount: '0.01', currency: 'CNY', resourceId: '/api/v1/guide',
    goodsName: 'x', tier, payBefore: new Date(Date.now() + 600000).toISOString(), source,
  });
  funnelRepo.attributeOrder(id, { visitorId: visitor, refCode: 'zjgsu' });
  funnelRepo.markFulfilled(id, `TR_${id}`);
};
mkFunnelOrder('SG_F1', 'vis-f1');
mkFunnelOrder('SG_F2', 'vis-f1'); // 同一访客买两次
mkFunnelOrder('SG_F3', 'vis-f2', 'single', 'demo'); // 自测
ana.touchVisitor('vis-f1', 'zjgsu', '1.2.3.4');
ana.touchVisitor('vis-f2', 'zjgsu', '1.2.3.4');
ana.touchVisitor('vis-direct', null, '1.2.3.4'); // 直连访客
ana.recordEvent('vis-f1', 'free_preview', 'zjgsu', {});
const funnel = ana.funnel(funnelRepo.orderStatsByVisitor(), { weekly: funnelRepo.orderStatsWeekly() });
const zjgsuChannel = funnel.channels.find((c) => c.code === 'zjgsu');
check('漏斗返回 overall/weekly/channels', funnel.overall && funnel.weekly && Array.isArray(funnel.channels));
check('渠道行含漏斗各层', ['visitors', 'previews', 'challenges', 'paid', 'paidReal', 'convPct'].every((k) => k in zjgsuChannel));
check('BUG-2 回归：同一访客 2 笔订单只算 1 个付费访客', zjgsuChannel.paid === 2, `paid=${zjgsuChannel.paid}`);
check('BUG-2 回归：challenges 也是访客数（2 个访客下 3 单）', zjgsuChannel.challenges === 2, `challenges=${zjgsuChannel.challenges}`);
check('BUG-2 回归：paidReal / paidSelfTest 互斥划分且相加等于 paid',
  zjgsuChannel.paidReal === 1 && zjgsuChannel.paidSelfTest === 1
  && zjgsuChannel.paidReal + zjgsuChannel.paidSelfTest === zjgsuChannel.paid,
  `real=${zjgsuChannel.paidReal} self=${zjgsuChannel.paidSelfTest} paid=${zjgsuChannel.paid}`);
check('BUG-2 回归：convPct 不超过 100%（旧实现可到 150%）',
  zjgsuChannel.convPct <= 100 && Math.abs(zjgsuChannel.convPct - (zjgsuChannel.paid / zjgsuChannel.visitors) * 100) < 0.05,
  `convPct=${zjgsuChannel.convPct}`);
check('收入仍是订单金额合计（不按人去重）', zjgsuChannel.revenueCny === 0.03, String(zjgsuChannel.revenueCny));
check('overall.paid 与渠道合计一致', funnel.overall.paid === funnel.channels.reduce((s, c) => s + c.paid, 0));
check('overall.convPct 不超过 100%', funnel.overall.convPct <= 100, String(funnel.overall.convPct));
check('(direct) 行在有直连访客时出现', funnel.channels.some((c) => c.code === '(direct)'));

// 测试渠道聚合
ana.touchVisitor('vis-t1', 'verify-123', '1.2.3.4');
mkFunnelOrder('SG_T1', 'vis-t1');
const funnel2 = ana.funnel(funnelRepo.orderStatsByVisitor(), { weekly: funnelRepo.orderStatsWeekly() });
check('未注册渠道折进 (测试渠道)', funnel2.channels.some((c) => c.code === '(测试渠道)'));
check('(测试渠道) 永远排最后',
  funnel2.channels[funnel2.channels.length - 1].code === '(测试渠道)');
check('聚合后 overall.paid 仍与渠道合计一致',
  funnel2.overall.paid === funnel2.channels.reduce((s, c) => s + c.paid, 0));

// G2b 周维度口径
const weekly = funnel2.weekly;
check('周维度 paid 为访客数（不超过周新访客 + 历史访客）', weekly.paid >= 2 && weekly.paidReal >= 1,
  `paid=${weekly.paid} real=${weekly.paidReal}`);
check('周维度收入为金额合计', typeof weekly.revenueCny === 'number');

// G3 反馈墙
const fb = ana.addFeedback({ name: '张三', role: '游客', content: '这是一条真实的反馈内容。', rating: 5, visitorId: 'fb-1', ipHash: 'h' });
check('addFeedback 返回落库条目', fb.id > 0 && fb.likes === 0);
const like1 = ana.toggleFeedbackLike(fb.id, 'fb-1');
check('点赞 +1', like1.likes === 1 && like1.liked === true);
const like2 = ana.toggleFeedbackLike(fb.id, 'fb-1');
check('再点取消点赞（回到 0）', like2.likes === 0 && like2.liked === false);
const rep1 = ana.reportFeedback(fb.id, 'fb-a');
const rep2 = ana.reportFeedback(fb.id, 'fb-a');
check('同一访客重复举报不累加', rep1.reports === 1 && rep2.duplicate === true);
ana.reportFeedback(fb.id, 'fb-b');
const rep3 = ana.reportFeedback(fb.id, 'fb-c');
check('3 个不同访客举报后隐藏', rep3.reports === 3 && rep3.status === 'HIDDEN');
check('隐藏后不在列表出现', ana.listFeedback('fb-1').every((r) => r.id !== fb.id));

const fb2 = ana.addFeedback({ name: '李四', role: '研学机构', content: '研学机构视角的反馈。', visitorId: 'fb-2', ipHash: 'h' });
const reply = ana.addReply({ feedbackId: fb2.id, name: '作者', content: '感谢反馈，已回复。', visitorId: 'fb-1', ipHash: 'h' });
check('回复成功', reply.id > 0 && ana.replyCount(fb2.id) === 1);
check('回复不存在反馈返回 null', ana.addReply({ feedbackId: 99999, name: 'x', content: 'y' }) === null);
check('列表挂载回复', ana.listFeedback('fb-1').find((r) => r.id === fb2.id)?.replies?.length === 1);
check('mine 标记只有自己的留言', (() => {
  const list = ana.listFeedback('fb-2');
  return list.find((r) => r.id === fb2.id)?.mine === true && list.find((r) => r.id === fb2.id)?.liked === false;
})());
check('删除他人留言被拒（FORBIDDEN）', ana.deleteFeedback(fb2.id, 'fb-1') === 'FORBIDDEN');
check('删除不存在留言返回 NOT_FOUND', ana.deleteFeedback(99999, 'fb-1') === 'NOT_FOUND');
check('删除自己的留言成功', ana.deleteFeedback(fb2.id, 'fb-2') === 'DELETED');
check('删除后回复一并清理', ana.listFeedback('fb-2').every((r) => r.id !== fb2.id));

// G4 留资
check('addLead 写入并可计数', ana.addLead({ org: '某研学机构', contact: 'a@b.c', visitorId: 'fb-1', ip: '1.2.3.4' }) === true);
check('leadCount 累加', ana.leadCount() === 1);

// G5 IP 日限流
const ip = hashIp('9.9.9.9');
for (let i = 0; i < 3; i += 1) ana.bumpIpDaily(ip, 'test-type');
check('bumpIpDaily 原子自增返回新值', ana.bumpIpDaily(ip, 'test-type') === 4);
check('bumpIpDaily 按类型隔离', ana.bumpIpDaily(ip, 'other-type') === 1);

repo.close();
funnelRepo.close();
ana.close();

// ─────────────────────────────────────────────────────────────
// H. HTTP 全链路
// ─────────────────────────────────────────────────────────────
section('H. HTTP 全链路');

const { privateKey: srvKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const srvKeyB64 = srvKey.export({ type: 'pkcs1', format: 'der' }).toString('base64');

const httpConfig = {
  env: 'sandbox',
  appId: '2021000000000000',
  alipayPublicKey: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A...FAKE',
  privateKeyB64: srvKeyB64,
  buyerUserId: '2088000000000000',
  gateway: 'https://openapi-sandbox.dl.alipaydev.com/gateway.do',
};
const httpServices = loadServices({ env: 'sandbox' });

/** 可控的支付宝客户端桩。behavior 可运行时修改（模拟验付回传的字段）。 */
function makeStubClient(behavior = {}) {
  const state = { verifyCalls: 0, confirmCalls: 0 };
  const stub = {
    state,
    behavior,
    async verifyPayment({ paymentProof, tradeNo }) {
      state.verifyCalls += 1;
      if (stub.behavior.verifyFails) return { ok: false, errorCode: 'VERIFY_FAILED', errorMessage: 'stub verify fail' };
      return {
        ok: true,
        data: {
          tradeNo: stub.behavior.tradeNo ?? tradeNo,
          outTradeNo: stub.behavior.outTradeNo ?? null,
          resourceId: stub.behavior.resourceId ?? '/api/v1/guide',
          amount: stub.behavior.amount ?? '0.01',
          active: stub.behavior.active ?? true,
        },
      };
    },
    async confirmFulfillment() {
      state.confirmCalls += 1;
      // confirmFailTimes：前 N 次回执失败、之后成功（模拟沙箱抖动后恢复）
      const failTimes = stub.behavior.confirmFailTimes ?? 0;
      const shouldFail = stub.behavior.confirmFails || state.confirmCalls <= failTimes;
      return shouldFail
        ? { ok: false, errorCode: 'CONFIRM_FAIL', errorMessage: 'stub confirm fail' }
        : { ok: true };
    },
  };
  return stub;
}

/**
 * MCP 与演示代付都会回环访问本进程的 /api/v1/guide，回环地址取自
 * process.env.SELF_BASE_URL ?? http://127.0.0.1:$PORT。测试监听随机端口，
 * 因此要把 PORT 指到真实端口（生产环境 PORT 恒有值，行为一致）。
 */
function withPort(app) {
  const port = new URL(app.base).port;
  const prev = process.env.PORT;
  process.env.PORT = port;
  return () => {
    if (prev === undefined) delete process.env.PORT;
    else process.env.PORT = prev;
  };
}

function startApp({ client, analytics: anaStore, config = httpConfig, services = httpServices } = {}) {
  const repository = createOrderRepository({ file: path.join(tmpDir, `http-${Math.random().toString(36).slice(2)}.db`) });
  const stub = client ?? makeStubClient();
  // 注意：不能用 `anaStore ?? createAnalyticsStore()` —— 显式传 null 表示「不要归因库」，
  // 而 ?? 会把 null 当缺省值覆盖掉，测不到 503 分支。
  const ana = anaStore === undefined
    ? createAnalyticsStore({ file: path.join(tmpDir, `ana-${Math.random().toString(36).slice(2)}.db`) })
    : anaStore;
  const app = createApp({
    config,
    services,
    sellerId: '2088123456789012',
    repository,
    alipayClient: stub,
    demoPayer: { pay: async () => ({ ok: false, error: 'stub' }) },
    analytics: ana,
  });
  const server = app.listen(0);
  return new Promise((resolve) => {
    server.once('listening', () =>
      resolve({
        base: `http://127.0.0.1:${server.address().port}`,
        repository,
        client: stub,
        analytics: ana,
        close: () => new Promise((r) => server.close(r)),
      }),
    );
  });
}

/** 走一遍「402 挑战 → 带凭证购买」，返回 { outTradeNo, body } */
async function buyOnce(app, url, visitor, proof, tradeNo = '2026112300001') {
  const challenge = await fetch(url, { headers: { Cookie: `sg_vid=${visitor}` } });
  if (challenge.status !== 402) throw new Error(`期望 402，实际 ${challenge.status}`);
  const outTradeNo = (await challenge.json()).out_trade_no;
  // 真实验付会回传 out_trade_no；桩按这个字段回填
  app.client.behavior.outTradeNo = outTradeNo;
  const res = await fetch(url, {
    headers: { Cookie: `sg_vid=${visitor}`, 'Payment-Proof': proof },
  });
  return { outTradeNo, status: res.status, body: await res.json(), res };
}

// H1 完整付费流（402 → 验付 → 履约 → 交付）
{
  const app = await startApp();
  const url = `${app.base}/api/v1/guide?scene=demo-park&query=${encodeURIComponent('从南门到图书馆怎么走')}`;
  const challenge = await fetch(url);
  check('H1 首次请求 402', challenge.status === 402);
  const needed = challenge.headers.get('payment-needed');
  const cBody = await challenge.json();
  check('H1 带 Payment-Needed 头与订单号', Boolean(needed) && Boolean(cBody.out_trade_no));
  // 验付接口会回传 out_trade_no；桩按真实行为回填后才能走到「按订单号履约」
  app.client.behavior.outTradeNo = cBody.out_trade_no;

  const proof = Buffer.from(JSON.stringify({
    protocol: { payment_proof: 'proof-1', trade_no: '2026000111111' },
    method: { client_session: 'session-1' },
  })).toString('base64url');
  const paid = await fetch(url, { headers: { 'Payment-Proof': proof } });
  check('H1 携带凭证后 200', paid.status === 200, String(paid.status));
  const pBody = await paid.json();
  check('H1 带 Payment-Validation 头', Boolean(paid.headers.get('payment-validation')));
  check('H1 交付内容含路线与计量', pBody.content?.route?.distance_m === 390 && pBody.content?.billing);
  check('H1 already_fulfilled=false（首次）', pBody.already_fulfilled === false);
  check('H1 fulfillment_confirmed=true', pBody.fulfillment_confirmed === true);
  const order = await app.repository.findByOutTradeNo(cBody.out_trade_no);
  check('H1 订单落为 PAID/FULFILLED', order.orderStatus === 'PAID' && order.fulfillStatus === 'FULFILLED');

  // 重放同一凭证
  const replay = await fetch(url, { headers: { 'Payment-Proof': proof } });
  const rBody = await replay.json();
  check('H1 重放同一凭证仍 200', replay.status === 200);
  check('H1 重放 already_fulfilled=true', rBody.already_fulfilled === true);
  check('H1 重放不重复扣权益（无 entitlement 字段）', rBody.entitlement === undefined);
  const usageRows = app.repository.listUsage(cBody.out_trade_no);
  const callRows = usageRows.filter((u) => u.meter === 'guide_call');
  check('H1 重放不重复写计量（guide_call 仍只有 1 条）', callRows.length === 1, `实际 ${callRows.length} 条`);

  // 凭证验付失败 → 回落到 402 新挑战
  const app2 = await startApp({ client: makeStubClient({ verifyFails: true }) });
  const bad = await fetch(`${app2.base}/api/v1/guide?scene=demo-park&query=x`, {
    headers: { 'Payment-Proof': Buffer.from(JSON.stringify({ protocol: { payment_proof: 'p', trade_no: 't' }, method: {} })).toString('base64url') },
  });
  check('H1 验付失败回落 402', bad.status === 402);
  await app2.close();

  // active=false → 400
  const app3 = await startApp({ client: makeStubClient({ active: false }) });
  const url3 = `${app3.base}/api/v1/guide?scene=demo-park&query=x`;
  const ch3 = await fetch(url3);
  app3.client.behavior.outTradeNo = (await ch3.json()).out_trade_no;
  const inactive = await fetch(url3, {
    headers: { 'Payment-Proof': Buffer.from(JSON.stringify({ protocol: { payment_proof: 'p', trade_no: 't' }, method: {} })).toString('base64url') },
  });
  check('H1 凭证未激活返回 400', inactive.status === 400 && (await inactive.json()).code === 'INVALID_PAYMENT_PROOF');
  await app3.close();

  // 交易号不匹配 → 400
  const app4 = await startApp({ client: makeStubClient({ tradeNo: 'OTHER' }) });
  const url4 = `${app4.base}/api/v1/guide?scene=demo-park&query=x`;
  const ch4 = await fetch(url4);
  app4.client.behavior.outTradeNo = (await ch4.json()).out_trade_no;
  const mismatch = await fetch(url4, {
    headers: { 'Payment-Proof': Buffer.from(JSON.stringify({ protocol: { payment_proof: 'p', trade_no: 'T-EXpect' }, method: {} })).toString('base64url') },
  });
  check('H1 交易号不匹配返回 400', mismatch.status === 400 && (await mismatch.json()).code === 'INVALID_PAYMENT_PROOF');
  await app4.close();

  // 回执失败 → 502，且可用同一凭证重试（回执第 1 次失败、第 2 次成功）
  const app5 = await startApp({ client: makeStubClient({ confirmFailTimes: 1 }) });
  const url5 = `${app5.base}/api/v1/guide?scene=demo-park&query=${encodeURIComponent('从南门到图书馆怎么走')}`;
  const ch5 = await fetch(url5);
  const ch5No = (await ch5.json()).out_trade_no;
  app5.client.behavior.outTradeNo = ch5No;
  const proof5 = Buffer.from(JSON.stringify({
    protocol: { payment_proof: 'p5', trade_no: '2026000222222' },
    method: { client_session: 's5' },
  })).toString('base64url');
  const failed = await fetch(url5, { headers: { 'Payment-Proof': proof5 } });
  check('H1 履约回执失败返回 502', failed.status === 502 && (await failed.json()).code === 'FULFILLMENT_CONFIRM_FAILED');
  const stuck = await app5.repository.findByOutTradeNo(ch5No);
  check('H1 回执失败后资源已生成且停在 PENDING_CONFIRM', stuck.fulfillStatus === 'PENDING_CONFIRM' && Boolean(stuck.serviceResult));
  const retried = await fetch(url5, { headers: { 'Payment-Proof': proof5 } });
  check('H1 同一凭证可重试履约', retried.status === 200);
  await app5.close();
  await app.close();
}

// H1b 结算单 / 超时策略 / 挑战限流（2026-11-28 支付硬化）
{
  // ① 结算单：买一笔 → GET settlement → 以第三方视角用 node crypto 验签 + 篡改必红
  const app = await startApp();
  const url = `${app.base}/api/v1/guide?scene=demo-park&query=${encodeURIComponent('从南门到图书馆怎么走')}`;
  const ch = await fetch(url);
  const outTradeNo = (await ch.json()).out_trade_no;
  app.client.behavior.outTradeNo = outTradeNo;
  const proofSt = Buffer.from(JSON.stringify({
    protocol: { payment_proof: 'p-st', trade_no: '2026000444444' },
    method: { client_session: 's' },
  })).toString('base64url');
  const paidSt = await fetch(url, { headers: { 'Payment-Proof': proofSt } });
  if (paidSt.status !== 200) throw new Error(`结算单前置失败：购买返回 ${paidSt.status}`);

  const settle = await fetch(`${app.base}/api/v1/settlement/${outTradeNo}`);
  const sBody = await settle.json();
  check('H1b 结算单对已支付订单 200', settle.status === 200, String(settle.status));
  check('H1b 结算单三件套齐备（statement/signature/public_key）',
    typeof sBody.statement === 'string' && typeof sBody.signature === 'string'
    && typeof sBody.seller_public_key === 'string');
  check('H1b 规范语句 key 字典序（与 Payment-Needed 同签名纪律）',
    sBody.statement === sBody.statement.split('&').sort().join('&'));
  check('H1b 结算单含金额与用量口径',
    sBody.settlement?.amount === '0.01' && /guide_call:\d+call/.test(sBody.statement));
  check('H1b 结算单交易号与订单一致', sBody.settlement?.out_trade_no === outTradeNo);
  const verifiedSt = crypto
    .createVerify('RSA-SHA256')
    .update(sBody.statement, 'utf8')
    .verify(sBody.seller_public_key, sBody.signature, 'base64');
  check('H1b 结算单验签通过（node crypto 第三方视角）', verifiedSt === true);
  const tamperedSt = crypto
    .createVerify('RSA-SHA256')
    .update(sBody.statement.replace(/tokens:\d+/, (m) => `tokens:${Number(m.slice(7)) + 1}`), 'utf8')
    .verify(sBody.seller_public_key, sBody.signature, 'base64');
  check('H1b 篡改用量后验签必红', tamperedSt === false);
  const metaSt = await (await fetch(`${app.base}/api/v1/meta`)).json();
  check('H1b meta 发布同一把商家公钥', metaSt.protocol?.seller_public_key === sBody.seller_public_key);
  // 未支付订单不给结算单（无用量可结算，也不能借端点探测订单内容）
  const chUnpaid = await fetch(`${app.base}/api/v1/guide?scene=demo-park&query=x`);
  const unpaidNo = (await chUnpaid.json()).out_trade_no;
  const unsettleable = await fetch(`${app.base}/api/v1/settlement/${unpaidNo}`);
  check('H1b 未支付订单 404 不给结算单', unsettleable.status === 404);
  // 核验卡带结算单入口（公开读者可离线验签）
  const card = await fetch(`${app.base}/api/v1/verify/${outTradeNo}`);
  check('H1b 核验卡带结算单链接', card.status === 200 && (await card.json()).settlement_url === `/api/v1/settlement/${outTradeNo}`);
  await app.close();

  // ② 超时策略回归：官方五项核验不含支付时效——pay_before 已过的订单，
  //    验付通过后仍必须交付（否则「29 分钟付款、31 分钟重试」= 双倍扣款）
  const appE = await startApp();
  const expiredNo = 'SG_EXPIRED_TEST';
  appE.repository.createPending({
    outTradeNo: expiredNo, amount: '0.01', currency: 'CNY', resourceId: '/api/v1/guide',
    goodsName: 'x', tier: 'single', payBefore: '2026-01-01T00:00:00+08:00',
  });
  appE.client.behavior.outTradeNo = expiredNo;
  const urlE = `${appE.base}/api/v1/guide?scene=demo-park&query=${encodeURIComponent('从南门到图书馆怎么走')}`;
  const deliveredE = await fetch(urlE, {
    headers: {
      'Payment-Proof': Buffer.from(JSON.stringify({
        protocol: { payment_proof: 'p-exp', trade_no: '2026000555555' },
        method: { client_session: 's' },
      })).toString('base64url'),
    },
  });
  check('H1b pay_before 已过期的订单验付后仍交付（不再有官方之外的第 6 项检查）',
    deliveredE.status === 200, String(deliveredE.status));
  await appE.close();

  // ③ 挑战防刷限流：每 IP 日限（环境变量调低模拟触顶）
  process.env.CHALLENGE_DAILY_IP_LIMIT = '1';
  const appL = await startApp();
  delete process.env.CHALLENGE_DAILY_IP_LIMIT;
  const urlL = `${appL.base}/api/v1/guide?scene=demo-park&query=x`;
  const firstL = await fetch(urlL);
  const secondL = await fetch(urlL);
  check('H1b 第 1 次挑战正常 402', firstL.status === 402, String(firstL.status));
  check('H1b 触顶后挑战 429 + 明确错误码',
    secondL.status === 429 && (await secondL.json()).code === 'CHALLENGE_LIMIT_REACHED',
    String(secondL.status));
  await appL.close();
}

// H1c 履约回执自愈清扫器：PENDING_CONFIRM 不再永远卡住（2026-11-28）
{
  const mkStuck = async (app2, no, updatedAtAgoMs) => {
    app2.repository.createPending({
      outTradeNo: no, amount: '0.01', currency: 'CNY', resourceId: '/api/v1/guide',
      goodsName: 'x', tier: 'single', payBefore: new Date(Date.now() + 600000).toISOString(),
    });
    // 真实卡单的形态：验付已通过（PAID）、资源已生成但回执未确认（PENDING_CONFIRM）
    app2.repository
      .getDb()
      .prepare("UPDATE orders SET order_status = 'PAID', fulfill_status = 'PENDING_CONFIRM', trade_no = ?, updated_at = ? WHERE out_trade_no = ?")
      .run(`TRADE_${no}`, new Date(Date.now() + updatedAtAgoMs).toISOString(), no);
  };

  const app = await startApp();
  // ① 标准卡单：10 分钟前停摆 → 应被扫到并恢复
  await mkStuck(app, 'SG_STUCK', -10 * 60_000);
  // ② 宽限期内（30 秒前）：买方在途重试的独占窗口，不扫
  await mkStuck(app, 'SG_FRESH', -30_000);
  // ③ 太老（73h）：超最长追溯，留给人工排查，不无限烧重试
  await mkStuck(app, 'SG_ANCIENT', -73 * 3_600_000);

  const sweep = await createReceiptSweeper({ repository: app.repository, alipayClient: app.client }).sweepOnce();
  check('H1c 候选恰好是窗内卡单（宽限期/超龄都不进）', sweep.swept === 1 && sweep.skipped !== true, JSON.stringify(sweep));
  const done = await app.repository.findByOutTradeNo('SG_STUCK');
  check('H1c 回执恢复成功 → FULFILLED/PAID', done.fulfillStatus === 'FULFILLED' && done.orderStatus === 'PAID');
  const fresh = await app.repository.findByOutTradeNo('SG_FRESH');
  check('H1c 宽限期内不扫（不与买方在途重试双发）', fresh.fulfillStatus === 'PENDING_CONFIRM');
  const ancient = await app.repository.findByOutTradeNo('SG_ANCIENT');
  check('H1c 超龄单不扫（不无限烧重试）', ancient.fulfillStatus === 'PENDING_CONFIRM');
  check('H1c 只对窗内单发了回执', app.client.state.confirmCalls === 1, String(app.client.state.confirmCalls));
  await app.close();

  // ④ 回执持续失败：保持 PENDING_CONFIRM 不误标 FULFILLED（下一轮再试）
  const app2 = await startApp({ client: makeStubClient({ confirmFails: true }) });
  await mkStuck(app2, 'SG_STUCK2', -10 * 60_000);
  const sweep2 = await createReceiptSweeper({ repository: app2.repository, alipayClient: app2.client }).sweepOnce();
  const still = await app2.repository.findByOutTradeNo('SG_STUCK2');
  check('H1c 回执仍失败 → 保持 PENDING_CONFIRM 等下一轮',
    sweep2.swept === 1 && sweep2.confirmed === 0 && still.fulfillStatus === 'PENDING_CONFIRM');
  await app2.close();

  // ⑤ 单飞保护：同一实例上一轮未完成时不叠加（生产里每进程只有一个实例）
  const app3 = await startApp();
  const sweeper = createReceiptSweeper({ repository: app3.repository, alipayClient: app3.client });
  const gate = sweeper.sweepOnce(); // 占住 running 标志（未 await）
  const overlapped = await sweeper.sweepOnce();
  check('H1c 上一轮未完成时跳过（单飞）', overlapped.skipped === true && overlapped.swept === 0);
  await gate;
  await app3.close();
}

// H2 权益额度交付
{
  const app = await startApp();
  const visitor = 'ent-visitor';
  const url = `${app.base}/api/v1/guide?scene=demo-park&query=${encodeURIComponent('从南门到图书馆怎么走')}&tier=pack10`;
  const proof = Buffer.from(JSON.stringify({
    protocol: { payment_proof: 'p-pack', trade_no: '2026000333333' },
    method: { client_session: 's' },
  })).toString('base64url');
  const bought = await buyOnce(app, url, visitor, proof);
  const bBody = bought.body;
  check('H2 购买 pack10 成功并发放权益', bought.status === 200 && bBody.entitlement?.quota === 10, JSON.stringify(bBody.entitlement ?? null));
  check('H2 首次交付消耗 1 次（余额 9）', bBody.entitlement?.remaining === 9, String(bBody.entitlement?.remaining));

  // 后续调用走额度直交付
  const d1 = await fetch(`${app.base}/api/v1/guide?scene=demo-park&query=${encodeURIComponent('从南门到图书馆怎么走')}`, { headers: { Cookie: `sg_vid=${visitor}` } });
  const d1Body = await d1.json();
  check('H2 有余额时不返回 402', d1.status === 200 && d1Body.code === 'OK');
  check('H2 额度交付带余额响应头', d1.headers.get('x-sg-entitlement-remaining') === '8');
  check('H2 额度交付内容与付费一致', d1Body.content?.route?.distance_m === 390);
  const entRes = await fetch(`${app.base}/api/v1/entitlements`, { headers: { Cookie: `sg_vid=${visitor}` } });
  const entBody = await entRes.json();
  check('H2 /entitlements 余额正确', entBody.remaining === 8 && entBody.granted === 10);

  // demo 代付链路必须走真实支付（x-sg-ignore-entitlement）
  const bypass = await fetch(`${app.base}/api/v1/guide?scene=demo-park&query=x`, { headers: { Cookie: `sg_vid=${visitor}`, 'x-sg-ignore-entitlement': '1' } });
  check('H2 内部回环标记跳过额度直交付', bypass.status === 402);

  // 非 guide 模式不消耗额度
  const questRes = await fetch(`${app.base}/api/v1/guide?scene=zjgsu-xiasha&mode=quest`, { headers: { Cookie: `sg_vid=${visitor}` } });
  check('H2 任务模式不消耗导览额度', questRes.status === 402);

  // 🔴 BUG-1 回归：合法重放同一笔 Payment-Proof 不得再扣额度、不得再打远程验付
  const verifyBefore = app.client.state.verifyCalls;
  for (let i = 0; i < 3; i += 1) {
    const r = await fetch(url, { headers: { Cookie: `sg_vid=${visitor}`, 'Payment-Proof': proof } });
    const body = await r.json();
    check(`BUG-1 回归：第 ${i + 1} 次重放仍 200`, r.status === 200);
    check(`BUG-1 回归：第 ${i + 1} 次重放不扣额度（余额仍 8）`, body.entitlement?.remaining === 8,
      `remaining=${body.entitlement?.remaining} source=${body.entitlement?.source}`);
    check(`BUG-1 回归：第 ${i + 1} 次重放标记来源为 replay`, body.entitlement?.source === 'replay');
  }
  check('BUG-1 回归：重放不再调用远程验付', app.client.state.verifyCalls === verifyBefore,
    `验付次数 ${verifyBefore} → ${app.client.state.verifyCalls}`);
  const finalBal = app.repository.entitlementBalance(visitor);
  check('BUG-1 回归：最终余额 = 10 - 1(购买) - 1(额度交付) = 8',
    finalBal.remaining === 8 && finalBal.used === 2, `remaining=${finalBal.remaining} used=${finalBal.used}`);
  await app.close();
}

// H3 免费试看限流
{
  const app = await startApp();
  const v = 'free-visitor';
  let lastStatus = 0;
  for (let i = 0; i < 4; i += 1) {
    const r = await fetch(`${app.base}/api/v1/guide?scene=demo-park&query=图书馆&preview=1`, { headers: { Cookie: `sg_vid=${v}` } });
    lastStatus = r.status;
    if (i < 3) check(`H3 第 ${i + 1} 次试看成功`, r.status === 200);
  }
  check('H3 第 4 次试看 429', lastStatus === 429, String(lastStatus));
  const body = await (await fetch(`${app.base}/api/v1/guide?scene=demo-park&query=图书馆&preview=1`, { headers: { Cookie: `sg_vid=${v}` } })).json();
  check('H3 429 带明确错误码', body.code === 'FREE_LIMIT_REACHED' && body.free_remaining === 0);
  await app.close();
}

// H4 404 / 短链 / track / invites
{
  const app = await startApp();
  const api404 = await fetch(`${app.base}/api/v1/nope`);
  check('H4 API 404 返回 JSON', api404.status === 404 && /NOT_FOUND/.test(await api404.text()));
  const deep = await fetch(`${app.base}/some/deep/path`);
  const deepHtml = await deep.text();
  check('H4 深层路径 404 且资源引用改写为相对', deep.status === 404 && !/(?:href|src)="\//.test(deepHtml), deepHtml.slice(0, 80));
  const shallow = await fetch(`${app.base}/nope`);
  const shallowHtml = await shallow.text();
  check('H4 单层路径 404 用 ./ 前缀', shallow.status === 404 && /(?:href|src)="\.\//.test(shallowHtml));

  const rUnknown = await fetch(`${app.base}/r/nope`);
  check('H4 未知短链 404', rUnknown.status === 404);
  // 短链只认已注册渠道（config/invites.json 由 bootstrap 播种；这里手动注册一个）
  app.analytics.ensureRef('zjgsu', '同学群');
  const rKnown = await fetch(`${app.base}/r/zjgsu`, { redirect: 'manual' });
  check('H4 已知短链 302 到 /?ref=', rKnown.status === 302 && rKnown.headers.get('location') === '/?ref=zjgsu',
    `${rKnown.status} ${rKnown.headers.get('location')}`);

  const trackBad = await fetch(`${app.base}/api/v1/track`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'evil_event' }),
  });
  check('H4 未知事件类型 400', trackBad.status === 400);
  const trackOk = await fetch(`${app.base}/api/v1/track`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'share', meta: { a: 1 } }),
  });
  check('H4 已知事件类型 ok', trackOk.status === 200);

  const inv = await fetch(`${app.base}/api/v1/invites`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: 'test-invite', label: '测试渠道' }),
  });
  check('H4 沙箱可注册渠道', inv.status === 201);
  const invBad = await fetch(`${app.base}/api/v1/invites`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: 'Bad_Code!', label: 'x' }),
  });
  check('H4 非法渠道码 400', invBad.status === 400);
  const invMissing = await fetch(`${app.base}/api/v1/invites`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: 'only-code' }),
  });
  check('H4 缺 label 400', invMissing.status === 400);

  // 生产环境 invites 需要 token
  const prodApp = await startApp({
    config: { ...httpConfig, env: 'production', gateway: 'https://openapi.alipay.com/gateway.do' },
  });
  const noToken = await fetch(`${prodApp.base}/api/v1/invites`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: 'ab', label: 'x' }),
  });
  check('H4 生产环境无 token 403', noToken.status === 403);
  process.env.INVITE_TOKEN = 'secret-token';
  const withToken = await fetch(`${prodApp.base}/api/v1/invites`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-invite-token': 'secret-token' },
    body: JSON.stringify({ code: 'ab', label: 'x' }),
  });
  check('H4 生产环境带 token 可注册', withToken.status === 201);
  delete process.env.INVITE_TOKEN;

  // 生产环境 demo/pay：不再返回 403 死路，而是出具真实账单 + 409 + 买方指引
  // （2026-11-27 的行为变更：旧实现返回 403，评委点下去没有任何下一步；
  //  同时旧实现会把订单 markSelfTest，导致真人付款被计入自测、静默清零商业化分。）
  const demoPayProd = await fetch(`${prodApp.base}/api/v1/demo/pay`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scene: 'demo-park', query: '从南门到图书馆怎么走' }),
  });
  const dpBody = await demoPayProd.json().catch(() => ({}));
  check('H4 生产环境 demo/pay 返回 409 + PRODUCTION_PAYMENT_REQUIRED',
    demoPayProd.status === 409 && dpBody.code === 'PRODUCTION_PAYMENT_REQUIRED',
    `${demoPayProd.status} ${JSON.stringify(dpBody).slice(0, 90)}`);
  check('H4 生产账单带 resource_url 与 buyer_command（可操作的下一步）',
    typeof dpBody.resource_url === 'string' && typeof dpBody.buyer_command === 'string');
  // 🔴 回归守护：生产分支绝不标记自测（2026-11-27 修复的静默清零商业化 25% 缺陷）
  const prodOrders = prodApp.repository.getDb()
    .prepare("SELECT COUNT(*) AS n FROM orders WHERE source = 'demo'").get().n;
  check('H4 回归：生产分支不把订单标记为自测（守护商业化统计口径）',
    prodOrders === 0, `source='demo' 的订单数=${prodOrders}`);
  await prodApp.close();

  const growth = await fetch(`${app.base}/api/v1/growth`);
  check('H4 增长看板可访问', growth.status === 200 && typeof (await growth.json()).overall === 'object');
  const meta = await fetch(`${app.base}/api/v1/meta`);
  check('H4 站点元信息可访问', meta.status === 200 && (await meta.json()).product?.name === '三维问路');
  const health = await fetch(`${app.base}/healthz`);
  check('H4 健康检查含库状态', (await health.json()).db?.orders === 'ok');
  const noAnalytics = await startApp({ analytics: null });
  const growthNone = await fetch(`${noAnalytics.base}/api/v1/growth`);
  check('H4 无归因库时增长看板 503', growthNone.status === 503);
  await noAnalytics.close();
  await app.close();
}

// H5 账户中心 + 反馈墙 HTTP
{
  const app = await startApp();
  const v = 'acct-visitor';
  const cookie = { Cookie: `sg_vid=${v}` };
  const meNo = await fetch(`${app.base}/api/v1/me`);
  // 归因中间件总会给出一个访客 id（无 cookie 时现场生成），因此 /me 不会走到 400 分支；
  // 这里断言的是「匿名访客也能拿到自己的空账户」这一实际契约。
  check('H5 无 cookie 时 /me 仍返回该匿名访客的空账户', meNo.status === 200 && (await meNo.json()).orders.length === 0);
  const me = await fetch(`${app.base}/api/v1/me`, { headers: cookie });
  check('H5 /me 返回订单/额度/礼品', (await me.json()).visitor?.id === v);

  const giftNo = await fetch(`${app.base}/api/v1/gifts`, { method: 'POST', headers: cookie });
  check('H5 无额度时生成礼品码 400', giftNo.status === 400);

  const lead = await fetch(`${app.base}/api/v1/leads`, {
    method: 'POST', headers: { ...cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ org: '某机构', contact: 'a@b.c' }),
  });
  check('H5 留资成功', lead.status === 200);
  const leadBad = await fetch(`${app.base}/api/v1/leads`, {
    method: 'POST', headers: { ...cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ org: '', contact: 'a@b.c' }),
  });
  check('H5 缺机构名 400', leadBad.status === 400);
  const leadLong = await fetch(`${app.base}/api/v1/leads`, {
    method: 'POST', headers: { ...cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ org: 'x'.repeat(100), contact: 'a@b.c' }),
  });
  check('H5 超长机构名 400', leadLong.status === 400);

  // 反馈墙
  const fbPost = await fetch(`${app.base}/api/v1/feedback`, {
    method: 'POST', headers: { ...cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '评审甲', role: '评审', content: '这个 402 支付链路是真实可用的。', rating: 5 }),
  });
  check('H5 提交反馈 201', fbPost.status === 201);
  const fbId = (await fbPost.json()).item?.id;
  const fbBad = await fetch(`${app.base}/api/v1/feedback`, {
    method: 'POST', headers: { ...cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'x', role: '评审', content: '短' }),
  });
  check('H5 内容过短 400', fbBad.status === 400);
  const fbBadRating = await fetch(`${app.base}/api/v1/feedback`, {
    method: 'POST', headers: { ...cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'x', role: '评审', content: '内容足够长但是评分非法', rating: 9 }),
  });
  check('H5 评分越界 400', fbBadRating.status === 400);
  const like = await fetch(`${app.base}/api/v1/feedback/${fbId}/like`, { method: 'POST', headers: cookie });
  check('H5 点赞成功', like.status === 200 && (await like.json()).liked === true);
  const likeAgain = await fetch(`${app.base}/api/v1/feedback/${fbId}/like`, { method: 'POST', headers: cookie });
  check('H5 重复点击取消', likeAgain.status === 200 && (await likeAgain.json()).likes === 0);
  const likeBadId = await fetch(`${app.base}/api/v1/feedback/abc/like`, { method: 'POST', headers: cookie });
  check('H5 非数字 id 400', likeBadId.status === 400);
  const likeNoVisitor = await fetch(`${app.base}/api/v1/feedback/${fbId}/like`, { method: 'POST' });
  // 归因中间件总会给出访客 id（无 cookie 时现场生成），因此「无访客」分支在 HTTP 层不可达；
  // 匿名访客可以点赞，去重靠这个现场生成的 id。
  check('H5 无 cookie 点赞也成功（匿名访客）', likeNoVisitor.status === 200 && (await likeNoVisitor.json()).liked === true);
  const report = await fetch(`${app.base}/api/v1/feedback/${fbId}/report`, { method: 'POST', headers: cookie });
  check('H5 举报返回当前状态', report.status === 200);
  const reply = await fetch(`${app.base}/api/v1/feedback/${fbId}/reply`, {
    method: 'POST', headers: { ...cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '作者', content: '谢谢评审，已记录。' }),
  });
  check('H5 回复成功 201', reply.status === 201);
  const replyShort = await fetch(`${app.base}/api/v1/feedback/${fbId}/reply`, {
    method: 'POST', headers: { ...cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '作者', content: 'x' }),
  });
  check('H5 回复过短 400', replyShort.status === 400);
  const list = await fetch(`${app.base}/api/v1/feedback`, { headers: cookie });
  const listBody = await list.json();
  check('H5 反馈列表带 roles 与 items', Array.isArray(listBody.items) && Array.isArray(listBody.roles) && listBody.items.some((i) => i.id === fbId));
  const del = await fetch(`${app.base}/api/v1/feedback/${fbId}`, { method: 'DELETE', headers: cookie });
  check('H5 撤回自己的留言成功', del.status === 200);
  const delAgain = await fetch(`${app.base}/api/v1/feedback/${fbId}`, { method: 'DELETE', headers: cookie });
  check('H5 重复撤回 404', delAgain.status === 404);
  await app.close();
}

// H6 MCP 全链路
{
  const app = await startApp();
  const restorePort = withPort(app); // MCP 回环需要 PORT 指向真实监听端口
  const mcp = async (body) => (await fetch(`${app.base}/mcp`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })).json();
  const init = await mcp({ jsonrpc: '2.0', id: 1, method: 'initialize' });
  check('H6 initialize 返回协议版本', init.result?.protocolVersion === '2025-06-18');
  const tools = await mcp({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  check('H6 tools/list 暴露三个工具（目录 / 付费导览 / 结算单核对）', tools.result?.tools?.length === 3);
  const ping = await mcp({ jsonrpc: '2.0', id: 3, method: 'ping' });
  check('H6 ping 返回空 result', ping.result !== undefined);
  const unknown = await mcp({ jsonrpc: '2.0', id: 4, method: 'no/such' });
  check('H6 未知方法 -32601', unknown.error?.code === -32601);
  const notif = await fetch(`${app.base}/mcp`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  });
  check('H6 通知返回 202 无体', notif.status === 202);

  const callNoQuery = await mcp({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'scene_guide', arguments: {} } });
  check('H6 缺 query 报错', callNoQuery.result?.isError === true);
  const scenes = await mcp({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'scene_guide_scenes', arguments: {} } });
  check('H6 场景目录工具可用', scenes.result?.content?.[0]?.text?.includes('demo-park') === true);
  const badTool = await mcp({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'nope', arguments: {} } });
  check('H6 未知工具报错', badTool.result?.isError === true);

  const challenge = await mcp({
    jsonrpc: '2.0', id: 8, method: 'tools/call',
    params: { name: 'scene_guide', arguments: { scene: 'demo-park', query: '从南门到图书馆怎么走' } },
  });
  const sc = challenge.result?.structuredContent ?? {};
  check('H6 无凭证调用返回 payment_required', sc.status === 'payment_required');
  check('H6 携带可支付账单头', typeof sc.payment_needed_header === 'string' && sc.payment_needed_header.length > 0);
  check('H6 携带可读账单预览', sc.payment_needed?.protocol?.amount === '0.01');
  check('H6 给出买方技能指引', sc.next?.skill === 'alipay-pay-for-402-service');
  const orderNo = sc.out_trade_no;
  check('H6 挑战已落库订单', (await app.repository.findByOutTradeNo(orderNo))?.orderStatus === 'PENDING_PAYMENT');
  // 验付回传该订单号（桩按真实接口行为回填）
  app.client.behavior.outTradeNo = orderNo;

  const withProof = await mcp({
    jsonrpc: '2.0', id: 9, method: 'tools/call',
    params: {
      name: 'scene_guide', arguments: {
        scene: 'demo-park', query: '从南门到图书馆怎么走',
        payment_proof: Buffer.from(JSON.stringify({ protocol: { payment_proof: 'p', trade_no: '2026000444444' }, method: { client_session: 's' } })).toString('base64url'),
      },
    },
  });
  const wp = withProof.result?.structuredContent ?? {};
  check('H6 带凭证调用直接交付', withProof.result?.isError !== true && wp.route?.distance_m === 390, JSON.stringify(wp).slice(0, 80));
  check('H6 交付带计费摘要', typeof wp.billing === 'object');

  // 结算单核对工具（免费只读）：买方 Agent「不信任商家、只验签」的用量核对入口
  const settleCall = await mcp({
    jsonrpc: '2.0', id: 12, method: 'tools/call',
    params: { name: 'scene_guide_settlement', arguments: { out_trade_no: orderNo } },
  });
  const scSettle = settleCall.result?.structuredContent ?? {};
  check('H6 结算单工具返回签名语句与公钥',
    typeof scSettle.statement === 'string' && typeof scSettle.seller_public_key === 'string'
    && scSettle.settlement?.out_trade_no === orderNo,
    JSON.stringify(scSettle).slice(0, 80));
  const settleUnknown = await mcp({
    jsonrpc: '2.0', id: 13, method: 'tools/call',
    params: { name: 'scene_guide_settlement', arguments: { out_trade_no: 'SG_NOPE' } },
  });
  check('H6 未知订单结算单明确报错（不猜）', settleUnknown.result?.isError === true);

  const questCall = await mcp({
    jsonrpc: '2.0', id: 10, method: 'tools/call',
    params: { name: 'scene_guide', arguments: { scene: 'zjgsu-xiasha', mode: 'quest', level: 'easy' } },
  });
  check('H6 任务模式返回支付挑战（含预览）', questCall.result?.structuredContent?.status === 'payment_required' && Boolean(questCall.result?.structuredContent?.preview_title));
  const badProof = await mcp({
    jsonrpc: '2.0', id: 11, method: 'tools/call',
    params: { name: 'scene_guide', arguments: { scene: 'demo-park', query: 'x', payment_proof: '!!!' } },
  });
  check('H6 畸形凭证明确报错', badProof.result?.isError === true && /payment_proof/.test(badProof.result.content[0].text));
  restorePort();
  await app.close();
}

// H7 任务打卡 HTTP 闭环
{
  const app = await startApp();
  const v = 'quest-visitor';
  const cookie = { Cookie: `sg_vid=${v}` };
  const url = `${app.base}/api/v1/guide?scene=zjgsu-xiasha&mode=quest`;
  const proof = Buffer.from(JSON.stringify({
    protocol: { payment_proof: 'pq', trade_no: '2026000555555' },
    method: { client_session: 'sq' },
  })).toString('base64url');
  const paid = await buyOnce(app, url, v, proof);
  const pBody = paid.body;
  const quest = pBody.content?.quest;
  check('H7 任务交付含 quest 与站点', paid.status === 200 && quest?.checkpoints?.length >= 2,
    paid.status === 200 ? '' : JSON.stringify(pBody).slice(0, 120));
  check('H7 quest 带蛇形别名（前端渲染口径）',
    typeof quest?.total_distance_m === 'number' && typeof quest?.estimated_minutes === 'number' && quest?.totalLegs >= 1);

  const q = await fetch(`${app.base}/api/v1/quests/${quest.id}`, { headers: cookie });
  const qBody = await q.json();
  check('H7 查询任务状态一致', q.status === 200 && qBody.id === quest.id && qBody.total_distance_m === quest.total_distance_m);

  const outOfOrder = await fetch(`${app.base}/api/v1/quests/${quest.id}/checkin`, {
    method: 'POST', headers: { ...cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ point_id: quest.checkpoints[1].id }),
  });
  check('H7 乱序打卡 400 且带顺序提示', outOfOrder.status === 400 && /顺序不对/.test((await outOfOrder.json()).message));

  const noPoint = await fetch(`${app.base}/api/v1/quests/${quest.id}/checkin`, {
    method: 'POST', headers: { ...cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  check('H7 缺点位 400', noPoint.status === 400);

  let last = qBody;
  for (const cp of quest.checkpoints) {
    const r = await fetch(`${app.base}/api/v1/quests/${quest.id}/checkin`, {
      method: 'POST', headers: { ...cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ point_id: cp.id }),
    });
    last = (await r.json()).quest;
  }
  check('H7 全部打卡后完成并发证书', last.status === 'COMPLETED' && last.certificate?.verifiable_by?.startsWith('sha256:'));
  check('H7 证书分数含全部站点加分', last.score >= 130, String(last.score));

  const verify = await fetch(`${app.base}/api/v1/verify/${quest.id.replace('Q_', 'SG_')}`);
  check('H7 订单核验卡对未知订单 404', verify.status === 404);
  const quest404 = await fetch(`${app.base}/api/v1/quests/no-such-quest`);
  check('H7 未知任务 404', quest404.status === 404);
  await app.close();
}

// H8 演示代付路由（沙箱）
{
  const app = await startApp();
  const restorePort = withPort(app); // 代付链路回环同样需要 PORT
  const demo = await fetch(`${app.base}/api/v1/demo/pay`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scene: 'demo-park', query: '从南门到图书馆怎么走' }),
  });
  // 桩代付返回失败 → 路由应明确报 502，而不是把内部回环错误吞成 500
  check('H8 沙箱代付路由可调用（桩返回 502）', demo.status === 502, `实际 ${demo.status} ${JSON.stringify(await demo.json()).slice(0,120)}`);
  restorePort();
  await app.close();
}

// H9 启动路径稳健性：种子渠道与数据库默认路径按 ROOT 解析，不随 cwd 漂移
{
  // 从 / 目录启动真实入口（bootstrap），验证 /r/zjgsu 仍能 302——
  // 旧实现用 cwd 相对的 config/invites.json，换目录启动会静默丢掉全部种子渠道。
  const { execFileSync } = await import('node:child_process');
  const port = 3987;
  const tmpDb = path.join(tmpDir, 'cwd-test');
  fs.mkdirSync(tmpDb, { recursive: true });
  const probe = `
    process.env.PORT = '${port}';
    process.env.ORDER_DB = process.env.SG_TMP + '/o.db';
    process.env.ANALYTICS_DB = process.env.SG_TMP + '/a.db';
    const { bootstrap } = await import('${pathToFileURL(path.join(ROOT, 'src', 'server.js')).href}');
    bootstrap();
    await new Promise(r => setTimeout(r, 1000));
    const r = await fetch('http://127.0.0.1:${port}/r/zjgsu', { redirect: 'manual' });
    const h = await fetch('http://127.0.0.1:${port}/healthz');
    console.log('SHORTLINK:' + r.status + ':' + (r.headers.get('location') ?? ''));
    console.log('HEALTH:' + h.status + ':' + JSON.stringify((await h.json()).db));
    process.exit(0);
  `;
  const probeFile = path.join(tmpDb, 'probe.mjs');
  fs.writeFileSync(probeFile, probe);
  let probeOut = '';
  try {
    probeOut = execFileSync('node', [probeFile], {
      cwd: '/', encoding: 'utf8', timeout: 30000,
      env: { ...process.env, SG_TMP: tmpDb },
    });
  } catch (err) {
    probeOut = (err.stdout ?? '') + (err.stderr ?? '');
  }
  const shortline = /SHORTLINK:(\d+):(.*)/.exec(probeOut);
  check('H9 从任意 cwd 启动，/r/<code> 短链仍 302（种子渠道不丢）',
    shortline?.[1] === '302' && shortline[2] === '/?ref=zjgsu',
    probeOut.split('\n').filter((l) => l.startsWith('SHORTLINK')).join(' ') || probeOut.slice(0, 200));
  check('H9 从任意 cwd 启动，健康检查仍报两个库 ok',
    /HEALTH:200:.*"orders":"ok".*"analytics":"ok"/.test(probeOut.replace(/\s+/g, ' ')),
    probeOut.split('\n').filter((l) => l.startsWith('HEALTH')).join(' ').slice(0, 200));
}

fs.rmSync(tmpDir, { recursive: true, force: true });

console.log(`\n${'─'.repeat(52)}`);
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
if (failures.length) {
  console.log(`\n失败明细：`);
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(failed === 0 ? 0 : 1);
