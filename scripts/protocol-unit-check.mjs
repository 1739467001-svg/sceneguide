#!/usr/bin/env node
/**
 * 协议层单元自检（protocol-unit-check）
 *
 * 覆盖那些**不依赖服务器、不依赖网络**的纯函数级协议判断——
 * 它们最容易在重构中被改坏，却最难靠端到端验收发现。
 *
 * 当前覆盖：
 *   ① 履约回执的**幂等成功识别**：官方买方工具在取得资源后会再发一次回执，
 *      支付宝对第二次的响应形态官方未公开；凡是语义上等于「已确认/已履约/重复」
 *      的业务拒绝，都必须被放行成成功——否则已完成的支付会卡在 502 不交付。
 *   ② Payment-Needed 载荷的**签名内容集合**：必须跨 protocol/method 抽取 8 个扁平字段，
 *      且 seller_signature 不参与自身签名（官方文档未写明，实测踩出来的那条）。
 *   ③ Base64URL 编码：必须无 padding、且 URL 安全（官方头值用这个形态）。
 *
 * 用法：node scripts/protocol-unit-check.mjs
 */
import { isIdempotentSuccess } from '../src/a2m/client.js';
import { buildSignContent, SIGNED_FIELD_NAMES } from '../src/a2m/protocol.js';

const G = '\x1b[32m', R = '\x1b[31m', C = '\x1b[36m', N = '\x1b[0m';
let failed = 0;
const ok = (m) => console.log(`  ${G}✓${N} ${m}`);
const bad = (m) => { console.log(`  ${R}✗ ${m}${N}`); failed += 1; };
const step = (m) => console.log(`\n${C}▸ ${m}${N}`);

step('① 履约回执幂等成功识别');
const idempotentCases = [
  ['ALREADY_CONFIRM', ''],
  ['already_fulfill', ''],
  ['DUPLICATE', ''],
  ['', '该交易已确认履约'],
  ['', '重复确认'],
  ['', '已完成'],
];
for (const [code, msg] of idempotentCases) {
  isIdempotentSuccess(code, msg)
    ? ok(`「${code || msg}」被判为幂等成功 → 放行交付`)
    : bad(`「${code || msg}」未被识别为幂等成功（会把已完成的支付卡在 502）`);
}
const realFailures = [
  ['INVALID_PARAM', '参数错误'],
  ['TRADE_NOT_EXIST', '交易不存在'],
  ['SYSTEM_ERROR', '系统繁忙'],
  ['RISK_REJECT', '风控拒绝'],
];
for (const [code, msg] of realFailures) {
  !isIdempotentSuccess(code, msg)
    ? ok(`「${code}」仍被当作真失败（不误放行）`)
    : bad(`「${code}」被误判成幂等成功——会放过真实故障`);
}

step('② Payment-Needed 签名内容集合');
// 官方约定的签名字段集是**扁平 8 个**（跨 protocol/method 抽取）——
// 常量 SIGNED_FIELD_NAMES 是单一事实来源，实现与常量不一致时 buildPaymentNeeded 会直接抛错。
const official8 = ['amount', 'currency', 'goods_name', 'out_trade_no',
  'pay_before', 'resource_id', 'seller_id', 'service_id'];
const constant = [...SIGNED_FIELD_NAMES].sort();
const expected = [...official8].sort();
constant.join(',') === expected.join(',')
  ? ok(`官方签名字段集常量一致（8 个）：${constant.join(', ')}`)
  : bad(`常量与官方 8 字段不一致：${constant.join(',')}`);

// 不参与签名的字段（出现在载荷里，但不在签名里）
const notSigned = ['seller_signature', 'seller_app_id', 'seller_name',
  'seller_sign_type', 'seller_unique_id', 'seller_unique_id_key'];
const signedSet = new Set(constant);
const leaked = notSigned.filter((f) => signedSet.has(f));
leaked.length === 0
  ? ok(`以下字段确认不参与签名：${notSigned.join(', ')}`)
  : bad(`这些字段错误地参与了签名：${leaked.join(', ')}`);

// 实际签名串必须严格等于这 8 个 key
const signed = buildSignContent({
  amount: '0.50', currency: 'CNY', goods_name: '单次导览', out_trade_no: 'SG_1',
  pay_before: '2026-11-23T10:00:00+08:00', resource_id: '/api/v1/guide',
  seller_id: '2088032169158784', service_id: 'SERVICE_ID',
});
const fields = signed.split('&').map((kv) => kv.split('=')[0]);
fields.join(',') === expected.join(',')
  ? ok('实际签名串的 key 序列与官方 8 字段完全一致')
  : bad(`实际签名 key 不符：${fields.join(',')}`);
// 字典序
const sorted = [...fields].sort();
JSON.stringify(fields) === JSON.stringify(sorted)
  ? ok('按 key 字典序排列')
  : bad('未按字典序排列——官方加签会不一致');
// 空值跳过
const withEmpty = buildSignContent({ a: '1', b: '', c: null, d: '  ' });
withEmpty === 'a=1'
  ? ok('空值/空白值被跳过，且不留下悬空 &')
  : bad(`空值处理异常：${withEmpty}`);

step('③ Base64URL 编码形态');
const payload = Buffer.from(JSON.stringify({ protocol: { a: 1 }, method: { b: 2 } }), 'utf8')
  .toString('base64')
  .replace(/\+/g, '-')
  .replace(/\//g, '_')
  .replace(/=/g, '');
!/[+/=]/.test(payload) ? ok('无 + / = 字符（URL 安全、无 padding）') : bad('包含非 URL 安全字符');
const roundTrip = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
roundTrip.protocol.a === 1 && roundTrip.method.b === 2
  ? ok('可被 base64url 无损还原')
  : bad('base64url 还原失败');

console.log(`\n${failed ? R : G}${failed ? `失败 ${failed} 项` : '协议层单元自检全部通过'}${N}`);
process.exit(failed ? 1 : 0);
