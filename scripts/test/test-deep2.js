/**
 * 第二轮测试套件（scripts/test/test-deep2.js）。
 *
 * 定位：smoke.js 覆盖协议主路径，test-deep.js 覆盖服务端模块与 HTTP 链路；
 * 本套件补上剩下三类高风险面：
 *   A. 场景数据完整性（OSM 产物的结构不变量——悬空引用/重复 ID/自环/坐标）
 *   B. 沙箱演示代付 demo/pay.js（键名转换、时间戳、重试与失败分支）
 *   C. 支付宝客户端 a2m/client.js 的重试口径（不可解析才重试，业务拒绝不重试）
 *   D. 并发原子性（履约抢占、额度扣减、打卡去重）
 *   E. 前后端契约（前端调的每个端点都存在、静态引用存在、版本号一致）
 *   F. 工程健全性（scripts 语法、package.json 引用的脚本存在）
 *
 * 用法：node scripts/test/test-deep2.js
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { ROOT, loadServices } from '../../src/config.js';
import { getScene, listScenes } from '../../src/scene/scenes.js';
import { answerGuide, planRoute, namedNodes } from '../../src/scene/index.js';
import { createQuest } from '../../src/scene/quest.js';
import { createDemoPayer } from '../../src/demo/pay.js';
import { createAlipayClient } from '../../src/a2m/client.js';
import { createOrderRepository } from '../../src/orders/repository.js';
import { createApp } from '../../src/server.js';

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

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-deep2-'));

// ─────────────────────────────────────────────────────────────
// A. 场景数据完整性
// ─────────────────────────────────────────────────────────────
section('A. 场景数据完整性');

const SCENE_DIR = process.env.SCENE_DIR ?? path.resolve(ROOT, 'data', 'scenes');
const sceneFiles = fs.existsSync(SCENE_DIR)
  ? fs.readdirSync(SCENE_DIR).filter((f) => f.endsWith('.json'))
  : [];
check('场景目录可读取', sceneFiles.length >= 2, `目录=${SCENE_DIR}，文件=${sceneFiles.length}`);

const seenSceneIds = new Set();
for (const file of sceneFiles) {
  const label = `[${file}]`;
  let scene;
  try {
    scene = JSON.parse(fs.readFileSync(path.join(SCENE_DIR, file), 'utf8'));
  } catch (err) {
    check(`${label} JSON 可解析`, false, err.message);
    continue;
  }
  check(`${label} 有 id/nodes/edges`, Boolean(scene?.id) && Array.isArray(scene.nodes) && Array.isArray(scene.edges));

  const ids = scene.nodes.map((n) => n.id);
  check(`${label} node id 无重复`, new Set(ids).size === ids.length);
  check(`${label} scene.id 全局唯一`, !seenSceneIds.has(scene.id), `重复 id=${scene.id}`);
  seenSceneIds.add(scene.id);

  const idSet = new Set(ids);
  const dangling = scene.edges.filter((e) => !idSet.has(e.from) || !idSet.has(e.to));
  check(`${label} 边引用无悬空`, dangling.length === 0, `${dangling.length} 条，例：${JSON.stringify(dangling[0])}`);

  const selfLoops = scene.edges.filter((e) => e.from === e.to);
  check(`${label} 无自环边`, selfLoops.length === 0, `${selfLoops.length} 条`);

  const edgeKeys = new Set();
  let dupEdges = 0;
  for (const e of scene.edges) {
    const k = [e.from, e.to].sort().join('|');
    if (edgeKeys.has(k)) dupEdges += 1;
    edgeKeys.add(k);
  }
  check(`${label} 无重复边（无向口径）`, dupEdges === 0, `${dupEdges} 条`);

  const badXy = scene.nodes.filter((n) => !Array.isArray(n.xy) || n.xy.length !== 2 || !n.xy.every((v) => Number.isFinite(v)));
  check(`${label} 所有节点 xy 为两个有限数`, badXy.length === 0, `${badXy.length} 个，例：${JSON.stringify(badXy[0]?.id)}`);

  const badCost = scene.edges.filter((e) => !Number.isFinite(e.cost_m) || e.cost_m < 0);
  check(`${label} 所有边 cost_m 为非负有限数`, badCost.length === 0, `${badCost.length} 条`);
  // 0 成本边是 OSM「同点多 way」的产物（两个节点坐标完全重合），对 Dijkstra 无害；
  // 单独计数而不是判失败——这是已知的数据质量现象，不是功能缺陷。
  const zeroCost = scene.edges.filter((e) => e.cost_m === 0);
  if (zeroCost.length) {
    const coincident = zeroCost.filter((e) => {
      const a = scene.nodes.find((n) => n.id === e.from);
      const b = scene.nodes.find((n) => n.id === e.to);
      return a && b && Math.hypot(b.xy[0] - a.xy[0], b.xy[1] - a.xy[1]) === 0;
    }).length;
    check(`${label} 0 成本边均源于坐标重合的重复节点（OSM 已知产物）`, coincident === zeroCost.length,
      `${coincident}/${zeroCost.length}`);
  }

  const noLonlat = scene.nodes.filter((n) => !n.lonlat || !n.lonlat.every((v) => Number.isFinite(v)));
  check(`${label} 所有节点带合法 lonlat`, noLonlat.length === 0, `${noLonlat.length} 个`);

  // bbox 与 lonlat 的一致性（OSM 产物应当落在自己的 bbox 内）
  if (Array.isArray(scene.bbox) && scene.bbox.length === 4) {
    const [w, s, e, n] = scene.bbox;
    const outsideCount = scene.nodes.filter((nd) => {
      const [lo, la] = nd.lonlat ?? [NaN, NaN];
      return !(lo >= w - 1e-6 && lo <= e + 1e-6 && la >= s - 1e-6 && la <= n + 1e-6);
    }).length;
    check(`${label} lonlat 全部落在 bbox 内`, outsideCount === 0, `${outsideCount} 个越界`);
  }

  // footprints（楼体）引用的节点应当存在
  const footprints = scene.footprints ?? [];
  if (footprints.length) {
    const badFp = footprints.filter((f) => f.id && !idSet.has(f.id));
    check(`${label} footprints 引用的节点存在`, badFp.length === 0, `${badFp.length} 个悬空`);
    const badRing = footprints.filter((f) => !Array.isArray(f.ring) || f.ring.length < 3);
    check(`${label} footprints 的 ring 至少 3 个顶点`, badRing.length === 0, `${badRing.length} 个`);
  }

  // 命名地标必须非空（否则任务/导览无点可挑）
  check(`${label} 有命名地标`, namedNodes(scene).length >= 3, `${namedNodes(scene).length} 个`);

  // 内核在该数据上必须能跑通：随机取两个命名地标，规划不得崩
  const named = namedNodes(scene);
  let kernelOk = true;
  let kernelDetail = '';
  for (let i = 0; i < Math.min(5, named.length); i += 1) {
    const a = named[i];
    const b = named[(i + 7) % named.length];
    if (a.id === b.id) continue;
    const r = planRoute(scene, a.id, b.id);
    if (r.found) {
      if (!(r.distanceM > 0) || r.points.length < 2) { kernelOk = false; kernelDetail = `${a.id}→${b.id} 距离/点数异常`; break; }
      if (r.points[0].id !== a.id) { kernelOk = false; kernelDetail = `${a.id}→${b.id} 折线缺起点`; break; }
    }
  }
  check(`${label} 内核在其上跑通（距离/起点正确）`, kernelOk, kernelDetail);

  // 任务生成必须可用（这是付费交付物）
  const q = createQuest({ sceneId: scene.id, checkpointNames: [] });
  check(`${label} 可自动生成任务`, q.ok === true, q.error ?? '');
  if (q.ok) {
    const cpIds = q.quest.checkpoints.map((c) => c.id);
    check(`${label} 任务打卡点互不相同`, new Set(cpIds).size === cpIds.length);
    check(`${label} 任务打卡点都在该场景内`, cpIds.every((id) => idSet.has(id)));
    check(`${label} 任务线索数 = 打卡点数`, q.quest.clues.length === cpIds.length);
  }

  // 导览回答必须可用
  const g = answerGuide({ sceneId: scene.id, query: `${named[0].name}在哪里` });
  check(`${label} 导览可回答地标查询`, g.ok === true && /位于|方位|侧/.test(g.answer ?? ''), (g.answer ?? '').slice(0, 40));
}

// listScenes 与磁盘一致
check('listScenes 覆盖全部磁盘场景', listScenes().length >= sceneFiles.length + 1,
  `list=${listScenes().length} 磁盘=${sceneFiles.length}（含内置 demo-park）`);
check('getScene 对未知 id 返回 null', getScene('__no_such_scene__') === null);

// ─────────────────────────────────────────────────────────────
// B. demo/pay.js（沙箱演示代付）
// ─────────────────────────────────────────────────────────────
section('B. 沙箱演示代付');

const SANDBOX_CASHIER = 'http://aicashier.dl.alipaydev.com/openclawpay/agent/v1/pay';

/** 用桩替换全局 fetch，记录调用并返回预设响应 */
function stubFetch(routes) {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    calls.push({ url: u, method: opts.method ?? 'GET', headers: opts.headers ?? {}, body: opts.body });
    for (const [pattern, make] of routes) {
      if (u.includes(pattern)) {
        const spec = typeof make === 'function' ? make(calls.length) : make;
        return new Response(JSON.stringify(spec.body ?? {}), {
          status: spec.status ?? 200,
          headers: { 'Content-Type': 'application/json', ...(spec.headers ?? {}) },
        });
      }
    }
    return new Response(JSON.stringify({ error: 'unstubbed', url: u }), { status: 500 });
  };
  return { calls, restore: () => { globalThis.fetch = realFetch; } };
}

const baseConfig = {
  env: 'sandbox',
  appId: '2021000000000000',
  alipayPublicKey: 'FAKE',
  privateKeyB64: 'FAKE',
  buyerUserId: '2088722118804281',
  gateway: 'https://openapi-sandbox.dl.alipaydev.com/gateway.do',
};

const neededB64 = Buffer.from(JSON.stringify({
  protocol: {
    out_trade_no: 'SG_1795396806779_e12a90266053',
    amount: '0.01',
    currency: 'CNY',
    resource_id: '/api/v1/guide',
    pay_before: '2026-11-23T10:00:00+08:00',
    seller_signature: 'sig',
    seller_sign_type: 'RSA2',
    seller_unique_id: '2088',
  },
  method: {
    seller_name: '三维问路',
    seller_id: '2088',
    seller_app_id: '2021000000000000',
    goods_name: '单次导览 · 三维场景导览',
    seller_unique_id_key: 'seller_id',
    service_id: 'api_mock_service_id',
  },
})).toString('base64url');

// B1 非沙箱拒绝
{
  const payer = createDemoPayer({ config: { ...baseConfig, env: 'production' } });
  const r = await payer.pay({ paymentNeededBase64: neededB64, buyerId: '2088', resourceUrl: 'http://x/' });
  check('B1 正式环境拒绝服务端代付', r.ok === false && /正式环境/.test(r.error), r.error);
}
// B2 缺买家账号
{
  const payer = createDemoPayer({ config: baseConfig });
  const r = await payer.pay({ paymentNeededBase64: neededB64, buyerId: '', resourceUrl: 'http://x/' });
  check('B2 缺沙箱买家账号时报错', r.ok === false && /买家/.test(r.error), r.error);
}
// B3 完整链路
{
  const stub = stubFetch([
    [SANDBOX_CASHIER, { body: { protocol: { tradeNo: '202611230001234567890' }, payScheme: 'alipays://x' } }],
    ['127.0.0.1', { body: { content: { answer: '从南门到图书馆，390 米。' } }, headers: { 'payment-validation': 'PVHEADER' } }],
  ]);
  const payer = createDemoPayer({ config: baseConfig });
  const r = await payer.pay({
    paymentNeededBase64: neededB64, buyerId: '2088722118804281', resourceUrl: 'http://127.0.0.1:3000/api/v1/guide?scene=demo-park',
  });
  stub.restore();
  check('B3 完整代付链路返回 ok', r.ok === true, JSON.stringify(r).slice(0, 120));
  check('B3 透传交易号', r.tradeNo === '202611230001234567890');
  check('B3 返回支付页链接（payScheme）', typeof r.payUrl === 'string' && r.payUrl.includes('render.alipay.com'));
  check('B3 带 Payment-Validation 预览', r.paymentValidationPreview?.startsWith('PVHEADER') === true);
  check('B3 重试请求带 Payment-Proof 头',
    stub.calls[1]?.headers?.['Payment-Proof']?.length > 0);
  const proofPayload = JSON.parse(Buffer.from(stub.calls[1].headers['Payment-Proof'], 'base64url').toString('utf8'));
  check('B3 Payment-Proof 含 payment_proof/trade_no/client_session',
    Boolean(proofPayload.protocol.payment_proof) && proofPayload.protocol.trade_no === '202611230001234567890' && Boolean(proofPayload.method.client_session));
  check('B3 代付下单体为驼峰键（收银接口要求）',
    (() => {
      const sent = JSON.parse(stub.calls[0].body);
      return Boolean(sent.method.sellerAppId) && Boolean(sent.protocol.outTradeNo) && Boolean(sent.protocol.sellerSignature);
    })());
  check('B3 代付带上买家标识与签名占位',
    (() => {
      const sent = JSON.parse(stub.calls[0].body);
      return sent.protocol.buyerUniqueId === '2088722118804281'
        && sent.method.buyerUniqueIdKey === 'buyerExternalId'
        && sent.signature.buyerSignature === '-'
        && /^\d{10,}$/.test(sent.signature.timestamp);
    })());
  // ⚠️ 本项目订单号是 SG_<13位毫秒>_<12位hex>，毫秒数在中间、尾部是 hex，
  //    timestampFromOutTradeNo 的 `(\d{10,})$` 永不命中 → 走 nowMs() 兜底。
  //    断言的是「兜底行为正确」而不是「取到了订单里的时间戳」（见源码注释）。
  check('B3 时间戳走兜底且为 13 位毫秒（订单号格式取不到，见源码注释）', (() => {
    const sent = JSON.parse(stub.calls[0].body);
    return /^\d{13}$/.test(sent.signature.timestamp)
      && Math.abs(Number(sent.signature.timestamp) - Date.now()) < 60000;
  })());
}
// B4 临时性失败重试后成功
{
  let cashierHits = 0;
  const stub = stubFetch([
    [SANDBOX_CASHIER, () => {
      cashierHits += 1;
      return cashierHits < 3
        ? { body: { errorCode: 'PAY_SUBMIT_FAILED', errorMessage: '系统繁忙，请稍后重试' } }
        : { body: { protocol: { tradeNo: 'T-OK' } } };
    }],
    ['127.0.0.1', { body: { content: { answer: 'ok' } } }],
  ]);
  const payer = createDemoPayer({ config: baseConfig });
  const t0 = Date.now();
  const r = await payer.pay({ paymentNeededBase64: neededB64, buyerId: '2088', resourceUrl: 'http://127.0.0.1:3000/x' });
  stub.restore();
  check('B4 临时性失败（繁忙）自动重试后成功', r.ok === true && cashierHits === 3, `hits=${cashierHits}`);
  check('B4 重试有退避（≥1s）', Date.now() - t0 >= 1000, `${Date.now() - t0}ms`);
}
// B5 参数类错误不重试
{
  let cashierHits = 0;
  const stub = stubFetch([
    [SANDBOX_CASHIER, () => { cashierHits += 1; return { body: { errorCode: 'SERVICE_PRICE_MISMATCH', errorMessage: '服务价格不匹配' } }; }],
  ]);
  const payer = createDemoPayer({ config: baseConfig });
  const r = await payer.pay({ paymentNeededBase64: neededB64, buyerId: '2088', resourceUrl: 'http://127.0.0.1:3000/x' });
  stub.restore();
  check('B5 参数类错误（价格不匹配）不重试', cashierHits === 1, `hits=${cashierHits}`);
  check('B5 明确返回失败原因', r.ok === false && /SERVICE_PRICE_MISMATCH/.test(r.error), r.error);
}
// B6 收银未返回交易号
{
  const stub = stubFetch([[SANDBOX_CASHIER, { body: { protocol: {} } }]]);
  const payer = createDemoPayer({ config: baseConfig });
  const r = await payer.pay({ paymentNeededBase64: neededB64, buyerId: '2088', resourceUrl: 'http://127.0.0.1:3000/x' });
  stub.restore();
  check('B6 收银未返回交易号时报错', r.ok === false && /交易号/.test(r.error), r.error);
}
// B7 收银 HTTP 错误
{
  const stub = stubFetch([[SANDBOX_CASHIER, { status: 502, body: { msg: 'bad gateway' } }]]);
  const payer = createDemoPayer({ config: baseConfig });
  const r = await payer.pay({ paymentNeededBase64: neededB64, buyerId: '2088', resourceUrl: 'http://127.0.0.1:3000/x' });
  stub.restore();
  check('B7 收银 HTTP 502 时报错（非 JSON 响应体不崩）', r.ok === false && /502/.test(r.error), r.error);
}
// B8 畸形账单头
{
  const stub = stubFetch([[SANDBOX_CASHIER, { body: { protocol: { tradeNo: 'T' } } }]]);
  const payer = createDemoPayer({ config: baseConfig });
  let threw = false;
  try {
    await payer.pay({ paymentNeededBase64: '!!!not-base64!!!', buyerId: '2088', resourceUrl: 'http://127.0.0.1:3000/x' });
  } catch { threw = true; }
  stub.restore();
  check('B8 畸形账单头被 JSON.parse 拒绝（不静默通过）', threw === true);
}

// ─────────────────────────────────────────────────────────────
// C. a2m/client.js 重试口径
// ─────────────────────────────────────────────────────────────
section('C. 支付宝客户端重试口径');

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const clientKeyB64 = privateKey.export({ type: 'pkcs1', format: 'der' }).toString('base64');
const clientPubPem = publicKey.export({ type: 'spki', format: 'pem' });

/** 起一个本地假网关，按 status/body 响应并计数 */
function fakeGateway(respond) {
  const state = { hits: 0 };
  const server = http.createServer((req, res) => {
    state.hits += 1;
    respond(req, res, state.hits);
  });
  return new Promise((resolve) => {
    server.listen(0, () => resolve({
      port: server.address().port,
      state,
      close: () => new Promise((r) => server.close(r)),
    }));
  });
}

// C1 成功路径
{
  const gw = await fakeGateway((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      alipay_aipay_agent_payment_verify_response: {
        code: '10000', trade_no: 'T1', out_trade_no: 'O1', resource_id: '/api/v1/guide', amount: '0.01', active: true,
      },
      sign: 'x',
    }));
  });
  const client = createAlipayClient({ ...baseConfig, privateKeyB64: clientKeyB64, alipayPublicKey: clientPubPem, gateway: `http://127.0.0.1:${gw.port}/gateway.do` });
  const r = await client.verifyPayment({ paymentProof: 'p', tradeNo: 'T1' });
  check('C1 验付成功映射字段', r.ok === true && r.data.tradeNo === 'T1' && r.data.outTradeNo === 'O1' && r.data.active === true);
  check('C1 成功路径只请求 1 次', gw.state.hits === 1);
  await gw.close();
}
// C2 业务拒绝：不重试，错误码透传
{
  const gw = await fakeGateway((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error_response: { code: '40004', sub_code: 'AUTH_BALANCE_NOT_ENOUGH', sub_msg: '余额不足' } }));
  });
  const client = createAlipayClient({ ...baseConfig, privateKeyB64: clientKeyB64, alipayPublicKey: clientPubPem, gateway: `http://127.0.0.1:${gw.port}/gateway.do` });
  const r = await client.verifyPayment({ paymentProof: 'p', tradeNo: 'T' });
  check('C2 业务拒绝不重试（只 1 次请求）', gw.state.hits === 1, `hits=${gw.state.hits}`);
  check('C2 业务拒绝透传 sub_code/sub_msg', r.ok === false && r.errorCode === 'AUTH_BALANCE_NOT_ENOUGH' && r.errorMessage === '余额不足');
  await gw.close();
}
// C3 不可解析响应：有界重试 4 次并归一为 MALFORMED（不抛异常）
{
  const gw = await fakeGateway((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{}'); // 缺 *_response 键 → SDK 抛「Response 格式错误」
  });
  const client = createAlipayClient({ ...baseConfig, privateKeyB64: clientKeyB64, alipayPublicKey: clientPubPem, gateway: `http://127.0.0.1:${gw.port}/gateway.do` });
  const r = await client.verifyPayment({ paymentProof: 'p', tradeNo: 'T' });
  check('C3 不可解析响应重试 4 次（1+3 退避）', gw.state.hits === 4, `hits=${gw.state.hits}`);
  check('C3 归一为 ALIPAY_RESPONSE_MALFORMED 且不抛异常',
    r.ok === false && r.errorCode === 'ALIPAY_RESPONSE_MALFORMED' && /已重试/.test(r.errorMessage));
  await gw.close();
}
// C4 履约回执成功 / 失败
{
  const gw = await fakeGateway((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ alipay_aipay_agent_fulfillment_confirm_response: { code: '10000' } }));
  });
  const client = createAlipayClient({ ...baseConfig, privateKeyB64: clientKeyB64, alipayPublicKey: clientPubPem, gateway: `http://127.0.0.1:${gw.port}/gateway.do` });
  const r = await client.confirmFulfillment({ tradeNo: 'T' });
  check('C4 履约回执成功返回 ok', r.ok === true);
  await gw.close();
}
{
  const gw = await fakeGateway((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ alipay_aipay_agent_fulfillment_confirm_response: { code: '40004', sub_code: 'CONFIRM_ERR', sub_msg: '回执失败' } }));
  });
  const client = createAlipayClient({ ...baseConfig, privateKeyB64: clientKeyB64, alipayPublicKey: clientPubPem, gateway: `http://127.0.0.1:${gw.port}/gateway.do` });
  const r = await client.confirmFulfillment({ tradeNo: 'T' });
  check('C4 履约回执失败原样返回（不伪装成功）', r.ok === false && r.errorCode === 'CONFIRM_ERR');
  await gw.close();
}
// C5 client_session 仅在存在时透传
{
  const gw = await fakeGateway((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ alipay_aipay_agent_payment_verify_response: { code: '10000', trade_no: 'T' } }));
      globalThis.__lastBiz = body;
    });
  });
  const client = createAlipayClient({ ...baseConfig, privateKeyB64: clientKeyB64, alipayPublicKey: clientPubPem, gateway: `http://127.0.0.1:${gw.port}/gateway.do` });
  await client.verifyPayment({ paymentProof: 'p', tradeNo: 'T' });
  const withoutSession = globalThis.__lastBiz;
  await client.verifyPayment({ paymentProof: 'p', tradeNo: 'T', clientSession: 'CS-1' });
  const withSession = globalThis.__lastBiz;
  check('C5 无 session 时不带 client_session 字段', !/client_session/.test(withoutSession));
  check('C5 有 session 时原样透传', /client_session/.test(withSession) && withSession.includes('CS-1'));
  await gw.close();
}

// ─────────────────────────────────────────────────────────────
// D. 并发原子性
// ─────────────────────────────────────────────────────────────
section('D. 并发原子性');

const repo = createOrderRepository({ file: path.join(tmpDir, 'concurrent.db') });
const RESOURCE_ID = '/api/v1/guide';

// D1 履约抢占：并发 5 次只生成一次资源
{
  repo.createPending({
    outTradeNo: 'SG_C1', amount: '0.01', currency: 'CNY', resourceId: RESOURCE_ID,
    goodsName: 'x', tier: 'single', payBefore: new Date(Date.now() + 600000).toISOString(),
  });
  let builds = 0;
  const results = await Promise.all(Array.from({ length: 5 }, () =>
    repo.prepareFulfillment({
      outTradeNo: 'SG_C1', tradeNo: 'T-C1', expectedAmount: '0.01', expectedResourceId: RESOURCE_ID,
      createResource: async () => {
        builds += 1;
        await new Promise((r) => setTimeout(r, 20)); // 让 5 个调用真正交错
        return { serviceResult: { answer: `build-${builds}` }, usage: [] };
      },
    }).catch((e) => ({ error: e.message })),
  ));
  const errors = results.filter((r) => r.error);
  check('D1 并发 5 次履约只生成 1 次资源', builds === 1, `实际生成 ${builds} 次`);
  check('D1 并发履约不抛未捕获错误', errors.length === 0, errors.map((e) => e.error).join('; ').slice(0, 120));
  const final = await repo.findByOutTradeNo('SG_C1');
  check('D1 最终订单有唯一持久化结果', Boolean(final.serviceResult) && final.serviceResult.answer === 'build-1');
}

// D2 额度扣减：并发 10 次消费 quota=3 的额度，恰好 3 次成功
{
  repo.grantEntitlement({ visitorId: 'conc-v', tier: 'pack10', outTradeNo: 'SG_C2', quota: 3 });
  const outcomes = await Promise.all(Array.from({ length: 10 }, async () => {
    await new Promise((r) => setTimeout(r, Math.random() * 10));
    const c = repo.consumeEntitlement('conc-v');
    return c ? 'ok' : 'null';
  }));
  const okCount = outcomes.filter((o) => o === 'ok').length;
  check('D2 并发消费不超扣（10 抢 3，恰好 3 次成功）', okCount === 3, `成功 ${okCount} 次`);
  const bal = repo.entitlementBalance('conc-v');
  check('D2 并发后余额归零且不倒退', bal.remaining === 0 && bal.used === 3, `used=${bal.used}`);
}

// D3 并发重复发放：同一订单并发 5 次只发一笔
{
  await Promise.all(Array.from({ length: 5 }, () =>
    Promise.resolve(repo.grantEntitlement({ visitorId: 'conc-v2', tier: 'pack10', outTradeNo: 'SG_C3', quota: 5 })),
  ));
  const bal = repo.entitlementBalance('conc-v2');
  check('D3 并发重复发放幂等（granted 仍为 5）', bal.granted === 5, `granted=${bal.granted}`);
}

// D4 打卡去重：并发打同一个点，恰好 1 次成功
{
  const quest = createQuest({ sceneId: 'zjgsu-xiasha', checkpointNames: [] }).quest;
  repo.createQuest({
    id: quest.id, outTradeNo: null, sceneId: 'zjgsu-xiasha', title: quest.title, level: quest.level,
    brief: quest.brief, totalDistanceM: quest.total_distance_m, estimatedMinutes: quest.estimated_minutes,
    checkpoints: quest.checkpoints, clues: quest.clues, legs: quest.legs, scoring: quest.scoring,
  });
  const firstPoint = quest.checkpoints[0].id;
  const results = await Promise.all(Array.from({ length: 5 }, async () => {
    await new Promise((r) => setTimeout(r, Math.random() * 8));
    try { return repo.checkin(quest.id, firstPoint); } catch (e) { return { threw: e.message }; }
  }));
  const okCount = results.filter((r) => r.ok === true).length;
  const dupCount = results.filter((r) => r.code === 'ALREADY_CHECKED_IN').length;
  check('D4 并发打同一点恰好 1 次成功', okCount === 1, `成功 ${okCount} 次`);
  check('D4 其余并发被判定为重复打卡', dupCount === 4, `重复 ${dupCount} 次`);
  const after = repo.findQuest(quest.id);
  check('D4 库里只落 1 条打卡记录', after.checkins.length === 1);
}

// D5 礼品码并发兑换：同一码并发 3 次，只发放 1 次额度
{
  repo.grantEntitlement({ visitorId: 'gift-owner', tier: 'pack10', outTradeNo: 'SG_C5', quota: 3 });
  const gift = repo.createGiftCode({ visitorId: 'gift-owner', tier: 'single' });
  const results = await Promise.all(Array.from({ length: 3 }, async () => {
    await new Promise((r) => setTimeout(r, Math.random() * 8));
    try { return repo.redeemGiftCode({ code: gift.code, visitorId: 'gift-recv' }); } catch (e) { return { threw: e.message }; }
  }));
  const okCount = results.filter((r) => r.ok === true).length;
  check('D5 礼品码并发兑换恰好 1 次成功', okCount === 1, `成功 ${okCount} 次`);
  check('D5 并发兑换不重复发额度（余额 1）', repo.entitlementBalance('gift-recv').remaining === 1,
    `remaining=${repo.entitlementBalance('gift-recv').remaining}`);
}

repo.close();

// ─────────────────────────────────────────────────────────────
// E. 前后端契约
// ─────────────────────────────────────────────────────────────
section('E. 前后端契约');

const appJs = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const indexHtml = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const serverSrc = fs.readFileSync(path.join(ROOT, 'src', 'server.js'), 'utf8');

// E1 前端调的每个端点都在服务端注册
{
  const called = new Set();
  for (const m of appJs.matchAll(/getJSON\(\s*['"`]([^'"`]+)['"`]\s*\)/g)) called.add(m[1].split('?')[0]);
  for (const m of appJs.matchAll(/fetch\(\s*['"`]([^'"`]+)['"`]/g)) called.add(m[1].split('?')[0]);
  const routeFiles = ['src/routes/guide.js', 'src/routes/account.js', 'src/routes/feedback.js', 'src/server.js']
    .map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n');
  const declared = new Set();
  for (const m of routeFiles.matchAll(/(?:router|app)\.(?:get|post|delete|put)\(\s*['"`]([^'"`]+)['"`]/g)) {
    // 统一口径：去掉前导斜杠 + 路径参数归一成 :x（前端用 ${...} 模板，服务端用 :id）
    declared.add(m[1].replace(/^\//, '').replace(/:\w+/g, ':x'));
  }
  // guide.js 的付费资源路径是变量（RESOURCE_PATH），单独补上
  declared.add('api/v1/guide');
  const normalize = (ep) => ep.replace(/^\//, '').replace(/\$\{[^}]*\}/g, ':x').replace(/:\w+/g, ':x');
  const missing = [...called].filter((ep) => {
    if (!ep.startsWith('api/') && !ep.startsWith('mcp')) return false;
    const n = normalize(ep);
    return ![...declared].some((d) => d === n || d === ep.replace(/^\//, ''));
  });
  check('E1 前端调用的端点都在服务端注册', missing.length === 0, `缺失：${missing.join(', ')}`);
}

// E2 index.html 引用的静态文件都存在
{
  const refs = [...indexHtml.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1])
    .filter((r) => !r.startsWith('http') && !r.startsWith('data:') && !r.startsWith('#') && !r.startsWith('/'));
  const missing = refs.filter((r) => !fs.existsSync(path.join(ROOT, 'public', r.split('?')[0])));
  check('E2 index.html 相对引用的文件都存在', missing.length === 0, `缺失：${missing.join(', ')}`);
}

// E3 资产版本号：index.html 的 ?v= 必须成对出现且非空（真正的缓存破除处）
{
  const versioned = [...indexHtml.matchAll(/(?:src|href)="([^"]+)\?v=([^"]*)"/g)].map((m) => `${m[1]}|${m[2]}`);
  check('E3 index.html 资产带版本号', versioned.length >= 2, versioned.join(' '));
  check('E3 版本号非空', versioned.every((v) => v.split('|')[1].length > 0));
}

// E4 回归：server.js 不得再出现「声明未使用」的 ASSET_VERSION（2026-11-23 清掉的死代码）
{
  // 先剥掉注释再判断——说明性注释里提到这个名字是允许的，真正要禁的是 `const X =`
  const codeOnly = serverSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  check('E4 server.js 不再声明未使用的 ASSET_VERSION', !/const\s+ASSET_VERSION\s*=/.test(codeOnly));
}

// E5 sw.js 预缓存清单引用的文件存在
{
  const swSrc = fs.readFileSync(path.join(ROOT, 'public', 'sw.js'), 'utf8');
  const precached = [...swSrc.matchAll(/['"`](\/[^'"`]+)['"`]/g)].map((m) => m[1]).filter((p) => /\.(js|css|html|json|png|webmanifest|txt|xml)$/.test(p));
  const missing = precached.filter((p) => !fs.existsSync(path.join(ROOT, 'public', p)));
  check('E5 sw.js 预缓存清单的文件都存在', missing.length === 0, `缺失：${missing.join(', ')}`);
}

// E6 data/ 下前端加载的 JSON 存在
{
  for (const f of ['protocol-trace.json', 'api-reference.json']) {
    check(`E6 public/data/${f} 存在且可解析`, (() => {
      try { JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'data', f), 'utf8')); return true; } catch { return false; }
    })());
  }
}

// E7 前端渲染依赖的蛇形字段在服务端交付里确实存在
{
  const { privateKey: k } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const repository = createOrderRepository({ file: path.join(tmpDir, 'contract.db') });
  const analytics = null;
  const services = loadServices({ env: 'sandbox' });
  const behavior = { outTradeNo: null };
  const stubClient = {
    async verifyPayment({ tradeNo }) {
      return { ok: true, data: { tradeNo, outTradeNo: behavior.outTradeNo, resourceId: '/api/v1/guide', amount: '0.01', active: true } };
    },
    async confirmFulfillment() { return { ok: true }; },
  };
  const app = createApp({
    config: { ...baseConfig, privateKeyB64: k.export({ type: 'pkcs1', format: 'der' }).toString('base64') },
    services, sellerId: '2088', repository, alipayClient: stubClient,
    demoPayer: { pay: async () => ({ ok: false }) }, analytics,
  });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const url = `${base}/api/v1/guide?scene=zjgsu-xiasha&mode=quest`;
  const ch = await fetch(url);
  const no = (await ch.json()).out_trade_no;
  behavior.outTradeNo = no;
  const proof = Buffer.from(JSON.stringify({ protocol: { payment_proof: 'p', trade_no: '2026112399999' }, method: { client_session: 's' } })).toString('base64url');
  const paid = await (await fetch(url, { headers: { 'Payment-Proof': proof } })).json();
  const q = paid.content?.quest ?? {};
  const frontendNeeds = ['total_distance_m', 'estimated_minutes', 'checkpoints', 'clues', 'legs', 'scoring', 'status', 'id', 'title'];
  const missingFields = frontendNeeds.filter((f) => q[f] === undefined);
  check('E7 任务交付含前端渲染所需的蛇形字段', missingFields.length === 0, `缺：${missingFields.join(', ')}`);
  check('E7 measuredLegs/totalLegs 为数字', Number.isFinite(q.measuredLegs) && Number.isFinite(q.totalLegs));
  const guideUrl = `${base}/api/v1/guide?scene=zjgsu-xiasha&query=${encodeURIComponent('从A教学楼到C教学楼怎么走')}`;
  const ch2 = await fetch(guideUrl);
  behavior.outTradeNo = (await ch2.json()).out_trade_no;
  const proof2 = Buffer.from(JSON.stringify({ protocol: { payment_proof: 'p2', trade_no: '2026112399998' }, method: {} })).toString('base64url');
  const guide = await (await fetch(guideUrl, { headers: { 'Payment-Proof': proof2 } })).json();
  const content = guide.content ?? {};
  const route = content.route ?? {};
  const guideNeeds = ['route', 'answer', 'evidence', 'billing', 'scene', 'intent', 'pois'];
  const missingGuide = guideNeeds.filter((f) => content[f] === undefined);
  check('E7 导览交付含前端渲染所需字段', missingGuide.length === 0, `缺：${missingGuide.join(', ')}`);
  check('E7 route 带折线（三维渲染用）', Array.isArray(route.polyline) && route.polyline.length >= 2,
    `polyline=${Array.isArray(route.polyline) ? route.polyline.length + '点' : '无'}`);
  check('E7 route 折线首尾与起终点一致',
    route.polyline?.[0]?.[0] === route.from?.xy?.[0] && route.polyline?.at(-1)?.[0] === route.to?.xy?.[0]);
  check('E7 billing 为中文字符串摘要', typeof content.billing?.guide_call === 'string');
  check('E7 evidence 带可复算几何哈希', /^sha256:[0-9a-f]{32}$/.test(content.evidence?.geometryHash ?? ''));
  server.close();
  repository.close();
}

// ─────────────────────────────────────────────────────────────
// F. 工程健全性
// ─────────────────────────────────────────────────────────────
section('F. 工程健全性');

// F1 所有 scripts 语法正确
{
  // scripts/ 与其下的 test/ 都要扫（测试套件 2026-11-27 归组到 scripts/test/）
  const collectScripts = (dir) => {
    const out = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) out.push(...collectScripts(p));
      else if (/\.(js|mjs)$/.test(e.name)) out.push(p);
    }
    return out;
  };
  const scriptPaths = collectScripts(path.join(ROOT, 'scripts'));
  const broken = [];
  for (const p of scriptPaths) {
    try { execFileSync('node', ['--check', p], { encoding: 'utf8', timeout: 20000 }); }
    catch (e) { broken.push(`${path.relative(ROOT, p)}: ${(e.stderr || '').split('\n')[0]}`); }
  }
  check(`F1 scripts/（含 test/）下 ${scriptPaths.length} 个脚本全部语法正确`, broken.length === 0, broken.join('; '));
}

// F2 package.json 里引用的脚本文件都存在
{
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const missing = [];
  for (const [name, cmd] of Object.entries(pkg.scripts ?? {})) {
    for (const m of String(cmd).matchAll(/(?:node|bash)\s+([\w./-]+\.(?:js|mjs|sh))/g)) {
      if (!fs.existsSync(path.join(ROOT, m[1]))) missing.push(`${name} → ${m[1]}`);
    }
  }
  check('F2 package.json scripts 引用的文件都存在', missing.length === 0, missing.join('; '));
  check('F2 已注册 test 脚本', typeof pkg.scripts.test === 'string' && pkg.scripts.test.includes('test-deep.js'));
}

// F3 部署配置引用的路径与仓库结构一致
{
  const compose = fs.readFileSync(path.join(ROOT, 'deploy', 'kit-sg60', 'compose.yml'), 'utf8');
  check('F3 compose 挂载数据卷到 /app/data', /\/app\/data/.test(compose));
  check('F3 compose 显式设置 ANALYTICS_DB', /ANALYTICS_DB/.test(compose));
  const dockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
  check('F3 Dockerfile 拷贝 config 与 data/scenes', /COPY config \.\/config/.test(dockerfile) && /COPY data\/scenes \.\/scenes/.test(dockerfile));
}

// F4 .gitignore 覆盖敏感与生成物
{
  const gi = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
  check('F4 .gitignore 忽略 production.json', /production\.json/.test(gi));
  check('F4 .gitignore 忽略 node_modules', /node_modules/.test(gi));
}

// ─────────────────────────────────────────────────────────────
// G. 数据库升级迁移 + 统计口径的 SQL 边界
// ─────────────────────────────────────────────────────────────
section('G. 升级迁移与统计口径');

// G1 旧库（无归因/来源/退款列，无权益·礼品·工单表）升级到当前代码
{
  const { default: Database } = await import('better-sqlite3');
  const legacyFile = path.join(tmpDir, 'legacy.db');
  const legacy = new Database(legacyFile);
  legacy.exec(`
    CREATE TABLE orders (
      out_trade_no   TEXT PRIMARY KEY,
      amount         TEXT NOT NULL,
      currency       TEXT NOT NULL,
      resource_id    TEXT NOT NULL,
      goods_name     TEXT NOT NULL,
      tier           TEXT NOT NULL,
      pay_before     TEXT NOT NULL,
      order_status   TEXT NOT NULL,
      fulfill_status TEXT NOT NULL,
      trade_no       TEXT,
      service_result TEXT,
      created_at     TEXT NOT NULL,
      updated_at     TEXT NOT NULL
    );
    CREATE TABLE usage_records (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      out_trade_no TEXT NOT NULL,
      meter        TEXT NOT NULL,
      quantity     REAL NOT NULL,
      unit         TEXT NOT NULL,
      created_at   TEXT NOT NULL
    );
  `);
  const then = new Date(Date.now() - 86400_000).toISOString();
  legacy.prepare(
    `INSERT INTO orders (out_trade_no, amount, currency, resource_id, goods_name, tier, pay_before,
                          order_status, fulfill_status, trade_no, created_at, updated_at)
     VALUES ('SG_LEGACY_1','0.01','CNY','/api/v1/guide','旧版订单','single',?,'PAID','FULFILLED','TRADE_LEGACY_1',?,?)`,
  ).run(then, then, then);
  legacy.prepare(
    'INSERT INTO usage_records (out_trade_no, meter, quantity, unit, created_at) VALUES (?,?,?,?,?)',
  ).run('SG_LEGACY_1', 'guide_call', 1, 'call', then);
  legacy.close();

  const legacyRepo = createOrderRepository({ file: legacyFile });
  const cols = legacyRepo.getDb().prepare('PRAGMA table_info(orders)').all().map((c) => c.name);
  check('G1 迁移补齐归因/来源列', ['visitor_id', 'ref_code', 'source'].every((c) => cols.includes(c)),
    cols.join(','));
  check('G1 迁移补齐退款列', ['refund_status', 'refunded_at', 'refund_reason'].every((c) => cols.includes(c)));
  const tables = legacyRepo.getDb().prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  check('G1 补齐权益/礼品/工单/任务表',
    ['entitlements', 'gift_codes', 'refund_tickets', 'quests', 'quest_checkins'].every((t) => tables.includes(t)),
    tables.join(','));

  const oldOrder = await legacyRepo.findByOutTradeNo('SG_LEGACY_1');
  check('G1 旧订单行不丢', oldOrder !== null && oldOrder.orderStatus === 'PAID');
  check('G1 旧订单 source 默认为 api', oldOrder.source === 'api', String(oldOrder.source));
  check('G1 旧订单用量记录保留', legacyRepo.listUsage('SG_LEGACY_1').length === 1);
  check('G1 旧订单交易号仍可查', legacyRepo.findByTradeNo('TRADE_LEGACY_1')?.outTradeNo === 'SG_LEGACY_1');

  // 升级后的库上，新功能必须全部可用
  legacyRepo.createPending({
    outTradeNo: 'SG_LEGACY_NEW', amount: '0.01', currency: 'CNY', resourceId: '/api/v1/guide',
    goodsName: 'x', tier: 'single', payBefore: new Date(Date.now() + 600000).toISOString(),
  });
  legacyRepo.attributeOrder('SG_LEGACY_NEW', { visitorId: 'mig-v', refCode: 'zjgsu' });
  legacyRepo.markSelfTest('SG_LEGACY_NEW');
  legacyRepo.grantEntitlement({ visitorId: 'mig-v', tier: 'pack10', outTradeNo: 'SG_LEGACY_NEW', quota: 5 });
  const migGift = legacyRepo.createGiftCode({ visitorId: 'mig-v', tier: 'single' });
  legacyRepo.markFulfilled('SG_LEGACY_NEW', 'TRADE_LEGACY_NEW');
  const migRefund = legacyRepo.refundOrder({ outTradeNo: 'SG_LEGACY_NEW', visitorId: 'mig-v', reason: '迁移测试' });
  check('G1 升级后归因/自测/额度/礼品/退款全部可用',
    (await legacyRepo.findByOutTradeNo('SG_LEGACY_NEW')).refCode === 'zjgsu'
    && (await legacyRepo.findByOutTradeNo('SG_LEGACY_NEW')).source === 'demo'
    && migGift.ok === true && migRefund.ok === true);
  legacyRepo.close();
}

// G2 🔴 回归：visitor_id 为 NULL 的真实订单不得被 paidReal 漏算
{
  const nullRepo = createOrderRepository({ file: path.join(tmpDir, 'nullvisitor.db') });
  const mk = (id, visitor, source) => {
    nullRepo.createPending({
      outTradeNo: id, amount: '0.01', currency: 'CNY', resourceId: '/api/v1/guide',
      goodsName: 'x', tier: 'single', payBefore: new Date(Date.now() + 600000).toISOString(), source,
    });
    if (visitor) nullRepo.attributeOrder(id, { visitorId: visitor, refCode: null });
    nullRepo.markFulfilled(id, `TR_${id}`);
  };
  mk('SG_NV_A', 'vis-a', 'api');        // 有访客 + 外部 → 真实
  mk('SG_NV_B', null, 'api');           // 无访客（迁移历史订单）+ 外部 → 也是真实
  mk('SG_NV_C', 'mcp-e2e-x', 'api');    // 验收脚本访客 → 自测
  mk('SG_NV_D', 'vis-d', 'demo');       // 演示代付 → 自测
  const s = nullRepo.stats();
  check('BUG-9 回归：4 笔已付订单全部计入 paid', s.paid === 4, `paid=${s.paid}`);
  check('BUG-9 回归：visitor_id 为 NULL 的外部订单计入 paidReal',
    s.paidReal === 2, `paidReal=${s.paidReal}（旧实现为 1，NULL 被 SQL 三值逻辑吞掉）`);
  check('BUG-9 回归：自测订单仍被正确排除',
    s.paid - s.paidReal === 2, `自测=${s.paid - s.paidReal}`);
  // 漏斗侧同口径
  const byVisitor = nullRepo.orderStatsByVisitor();
  check('BUG-9 回归：orderStatsByVisitor 只归集有访客的订单', byVisitor.length === 3,
    `${byVisitor.length} 行`);
  nullRepo.close();
}

// G3 跨页面资产版本一致（同一份 styles.css 不应有两个版本号）
{
  const versions = {};
  for (const page of ['index.html', 'account.html', 'verify.html']) {
    const html = fs.readFileSync(path.join(ROOT, 'public', page), 'utf8');
    const found = [...html.matchAll(/([\w.-]+\.css)\?v=([\w.-]+)/g)].map((m) => `${m[1]}=${m[2]}`);
    if (found.length) versions[page] = found;
  }
  const unique = [...new Set(Object.values(versions).flat())];
  check('G3 各页面 styles.css 版本号一致', unique.length === 1, unique.join(' vs '));
}

// F5 体检脚本 db-check.mjs：损坏库必须清晰报告而不是崩栈
{
  // 🔴 回归（2026-11-23）：旧实现 try 只有 finally 没有 catch，quick_check 在
  //    「文件不是数据库」时抛 SqliteError → 脚本崩栈，连第二个库都不检查、
  //    汇总与恢复步骤全不打印。而这个脚本存在的唯一目的就是发现这种库。
  const corruptFile = path.join(tmpDir, 'not-a-db.db');
  const junk = Buffer.alloc(4096);
  junk.write('SQLite format 3\u0000', 0, 'utf8');
  for (let i = 100; i < 4096; i += 1) junk[i] = (i * 7) % 256;
  fs.writeFileSync(corruptFile, junk);

  const runCheck = (orderDb, analyticsDb) => {
    try {
      const stdout = execFileSync('node', [path.join(ROOT, 'scripts', 'db-check.mjs')], {
        cwd: ROOT, encoding: 'utf8', timeout: 30000,
        env: { ...process.env, ORDER_DB: orderDb, ANALYTICS_DB: analyticsDb },
      });
      return { code: 0, stdout, stderr: '' };
    } catch (err) {
      return { code: err.status, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
    }
  };

  const corruptRun = runCheck(corruptFile, path.join(tmpDir, 'missing-analytics.db'));
  const clean = corruptRun.stdout.replace(/\x1b\[[0-9;]*m/g, '');
  check('F5 损坏库：退出码 1', corruptRun.code === 1, String(corruptRun.code));
  check('F5 损坏库：明确报告 quick_check 失败', /quick_check 失败/.test(clean));
  check('F5 损坏库：打印汇总', /发现 \d+ 处异常/.test(clean));
  check('F5 损坏库：打印恢复步骤', /恢复步骤/.test(clean));
  check('F5 损坏库：继续检查了第二个库（不中途崩栈）', /analytics\.db/.test(clean));
  check('F5 损坏库：stderr 无栈轨迹', !/SqliteError|at Database\.pragma/.test(corruptRun.stderr));

  const goodFile = path.join(tmpDir, 'healthy.db');
  execFileSync('node', ['-e', `
    const Database = require('${path.join(ROOT, 'node_modules', 'better-sqlite3')}');
    const d = new Database('${goodFile}');
    d.exec('CREATE TABLE t(a); INSERT INTO t VALUES(1);');
    d.close();
  `], { cwd: ROOT, encoding: 'utf8', timeout: 30000 });
  const goodRun = runCheck(goodFile, goodFile);
  check('F5 健康库：退出码 0 且体检通过', goodRun.code === 0 && /数据库体检通过/.test(goodRun.stdout));
  check('F5 健康库：输出含行数与 journal_mode', /journal_mode/.test(goodRun.stdout));
}

// F6 前端模块链：three-scene.js 的导入必须全部可解析
{
  // 🔴 vendored three.js 升级时最容易静默坏掉的地方：OrbitControls.js 具名导入的
  //    符号若在新版里被改名/移除，浏览器动态 import 会整体失败 → 三维场景白屏，
  //    而 Node 侧测试完全感知不到（这些文件只在浏览器里被加载）。
  const threeMod = fs.readFileSync(path.join(ROOT, 'public', 'vendor', 'three.module.js'), 'utf8');
  const exported = new Set();
  for (const m of threeMod.matchAll(/export\s*\{([^}]*)\}/g)) {
    m[1].split(',').forEach((s) => { const n = s.trim().split(/\s+as\s+/).pop().trim(); if (n) exported.add(n); });
  }
  for (const m of threeMod.matchAll(/export\s+(?:class|const|let|var|function|async function)\s+(\w+)/g)) exported.add(m[1]);
  check('F6 vendored three.module.js 有导出符号', exported.size > 100, `${exported.size} 个`);

  const oc = fs.readFileSync(path.join(ROOT, 'public', 'vendor', 'OrbitControls.js'), 'utf8');
  const ocBlock = /import\s*\{([^}]*)\}/.exec(oc);
  const ocNeeded = ocBlock ? ocBlock[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
  check('F6 OrbitControls 需要若干符号', ocNeeded.length >= 5, `${ocNeeded.length} 个`);
  const ocMissing = ocNeeded.filter((n) => !exported.has(n));
  check('F6 OrbitControls 的具名导入全部可解析（升级 three 时的断裂点）',
    ocMissing.length === 0, `缺失：${ocMissing.join(', ')}`);
  check('F6 OrbitControls 用相对路径导入 three（无裸 three 说明符）',
    /from\s*['"]\.\/three\.module\.js['"]/.test(oc) && !/from\s*['"]three['"]/.test(oc));

  const scene = fs.readFileSync(path.join(ROOT, 'public', 'three-scene.js'), 'utf8');
  check('F6 three-scene.js 导出 createScene3D', /export\s+function\s+createScene3D/.test(scene));
  check('F6 three-scene.js 全部用相对路径导入',
    [...scene.matchAll(/from\s*['"]([^'"]+)['"]/g)].every((m) => m[1].startsWith('.')));
  const appJs = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  check('F6 app.js 以 classic script 加载（无顶层 import/export，否则语法错误）',
    !appJs.split('\n').some((l) => /^(import|export)\s/.test(l.trim())));
  check('F6 app.js 动态 import three-scene 并调用 createScene3D',
    /import\(\s*[`'"]\.\/three-scene\.js/.test(appJs) && /createScene3D\s*\(/.test(appJs));

  // vendored three 与 node_modules 一致（防止手改过 vendor 却没改依赖）
  const vendored = path.join(ROOT, 'public', 'vendor', 'three.module.js');
  const installed = path.join(ROOT, 'node_modules', 'three', 'build', 'three.module.js');
  if (fs.existsSync(installed)) {
    check('F6 vendored three.module.js 与 node_modules 字节一致（无手改漂移）',
      fs.readFileSync(vendored).equals(fs.readFileSync(installed)));
  }
}

// F7 部署链路一致性：nginx → 宿主端口 → 容器端口 → 应用
{
  const compose = fs.readFileSync(path.join(ROOT, 'deploy', 'kit-sg60', 'compose.yml'), 'utf8');
  const nginxActive = fs.readFileSync(path.join(ROOT, 'deploy', 'kit-sg60', 'nginx-sceneguide.conf'), 'utf8');
  const dockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');

  const portMap = /"127\.0\.0\.1:(\d+):(\d+)"/.exec(compose);
  check('F7 compose 把宿主端口绑到 127.0.0.1（不对外）', Boolean(portMap) && portMap[0].startsWith('"127.0.0.1'));
  const nginxPort = /proxy_pass\s+http:\/\/127\.0\.0\.1:(\d+)/.exec(nginxActive);
  const containerPort = /ENV\s+PORT=(\d+)/.exec(dockerfile) ?? /PORT:\s*(\d+)/.exec(compose);
  check('F7 nginx 反代端口 = compose 宿主端口', portMap && nginxPort && portMap[1] === nginxPort[1],
    `nginx=${nginxPort?.[1]} compose=${portMap?.[1]}`);
  check('F7 compose 映射的容器端口 = 应用 PORT', portMap && containerPort && portMap[2] === containerPort[1],
    `映射=${portMap?.[2]} 应用=${containerPort?.[1]}`);
  check('F7 子路径前缀被 nginx 剥掉（proxy_pass 尾斜杠）', /proxy_pass\s+http:\/\/127\.0\.0\.1:\d+\/\s*;/.test(nginxActive));
  check('F7 反代透传 X-Forwarded-For（IP 限流的根基）', /X-Forwarded-For\s+\$proxy_add_x_forwarded_for/.test(nginxActive));
  check('F7 健康检查指向容器内回环', /127\.0\.0\.1:\d+\/healthz/.test(compose));
  // 服务端不依赖 X-Forwarded-Proto：现行 nginx 未设置它，确认无影响
  const srcAll = ['src/server.js', 'src/routes/guide.js', 'src/demo/pay.js', 'src/mcp/server.js']
    .map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n');
  check('F7 服务端不依赖 X-Forwarded-Proto（nginx 未设置亦无影响）',
    !/x-forwarded-proto|req\.protocol|req\.secure/i.test(srcAll));
}

// F8 SKILL.md（Agent 契约）与真实路由一致
{
  const skill = fs.readFileSync(path.join(ROOT, 'SKILL.md'), 'utf8');
  const routeSrc = ['src/routes/guide.js', 'src/routes/account.js', 'src/routes/feedback.js', 'src/server.js']
    .map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n');
  const declared = new Set();
  for (const m of routeSrc.matchAll(/(?:router|app)\.(?:get|post|delete|put)\(\s*['"`]([^'"`]+)['"`]/g)) {
    declared.add(m[1].replace(/^\//, '').replace(/:\w+/g, ':x'));
  }
  declared.add('api/v1/guide'); // RESOURCE_PATH 变量
  const skillEps = [...new Set([...skill.matchAll(/(\/api\/v1\/[\w/{}\-]+|\/mcp|\/r\/)/g)].map((m) => m[1]))];
  const normalize = (p) => p.replace(/^\//, '').replace(/:\w+/g, ':x').replace(/\/$/, '');
  const missing = skillEps.filter((e) => {
    const n = normalize(e);
    return ![...declared].some((d) => d === n || d === n.replace(/\/:x$/, '') || d.startsWith(`${n}/`));
  });
  check('F8 SKILL.md 描述的端点都在服务端注册', missing.length === 0, `缺失：${missing.join(', ')}`);
  check('F8 SKILL.md 说明 402 → Payment-Proof → 200 的主流程',
    /Payment-Needed/.test(skill) && /Payment-Proof/.test(skill) && /FULFILLMENT_CONFIRM_FAILED/.test(skill));
  check('F8 SKILL.md 记录了 MCP 发现入口', /POST\s+\/mcp/.test(skill) && /tools\/list/.test(skill));
  check('F8 SKILL.md 声明了买家自助端点（权益/转赠/售后/核验）',
    ['/api/v1/entitlements', '/api/v1/gifts', '/api/v1/me', '/api/v1/refunds', '/api/v1/verify/'].every((e) => skill.includes(e)));
}

fs.rmSync(tmpDir, { recursive: true, force: true });

console.log(`\n${'─'.repeat(52)}`);
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
if (failures.length) {
  console.log(`\n失败明细：`);
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(failed === 0 ? 0 : 1);
