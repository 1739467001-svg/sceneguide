#!/usr/bin/env node
/**
 * 官方接口字段限额自检（verify-official-limits）
 *
 * 为什么值得单独一项：
 *   官方 API 文档给了硬性字段限额（`[1,32]`、金额 ≤ 50 元、`pay_before` 不超过当前 12h …）。
 *   这些约束**沙箱不一定拦**（沙箱 mock 服务对部分字段宽松），于是一直没人验；
 *   但一旦切到生产，超限的字段会让收银/预下单直接拒单，
 *   而报错往往只是一个笼统的业务失败码——排查成本极高，且在截止日前最不该发生。
 *
 *   本项目当前的实测值（2026-11-27）：
 *     goods_name   最长 19 / 32
 *     service_id   API_0D6EEBE63AC54CD5 → 21 / 32
 *     out_trade_no SG_<13位时间戳>_<12位hex> → 29 / 32 ← 最贴上限的一项
 *     memo         11 / 32
 *     pay_before   +30 分钟 / 官方上限 12 小时
 *
 *   验的是**线上真实 402 响应里的值**，不是配置文件里的声明值——
 *   声明与实发不一致（例如路由里另拼了一份 goods_name）正是这类 bug 的典型形态。
 *
 * 用法：node scripts/verify/verify-official-limits.mjs
 *       BASE_URL=https://121.43.80.231/sceneguide node scripts/verify/verify-official-limits.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BASE = (process.env.BASE_URL ?? 'https://121.43.80.231/sceneguide').replace(/\/$/, '');

const G = '\x1b[32m', R = '\x1b[31m', Y = '\x1b[33m', C = '\x1b[36m', N = '\x1b[0m';
let failed = 0;
const ok = (m) => console.log(`  ${G}✓${N} ${m}`);
const bad = (m) => { console.log(`  ${R}✗ ${m}${N}`); failed += 1; };
const warn = (m) => console.log(`  ${Y}!${N} ${m}`);
const step = (m) => console.log(`\n${C}▸ ${m}${N}`);

const LIMIT = 32;   // 官方：out_trade_no / goods_name / service_id / memo 均为 string [1,32]
const MAX_AMOUNT = 50;
const MAX_PAY_BEFORE_HOURS = 12;

// ── ① 档位表里的声明值 ──────────────────────────────────────
step('① 档位表声明值（config/services.json）');
{
  const svc = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'services.json'), 'utf8'));
  for (const [name, t] of Object.entries(svc.tiers ?? {})) {
    const gn = `${t.label} · 三维场景导览`;
    const sid = String(t.serviceId ?? '');
    const problems = [];
    if ([...gn].length > LIMIT) problems.push(`goods_name ${[...gn].length} > ${LIMIT}`);
    if ([...sid].length > LIMIT) problems.push(`service_id ${[...sid].length} > ${LIMIT}`);
    if (!/^\d+(\.\d{1,2})?$/.test(String(t.unitPrice))) problems.push(`单价形制非法 ${t.unitPrice}`);
    else if (Number(t.unitPrice) < 0.01 || Number(t.unitPrice) > MAX_AMOUNT) problems.push(`单价 ${t.unitPrice} 越界`);
    problems.length === 0
      ? ok(`档位 ${name}：goods_name ${[...gn].length}/${LIMIT}，service_id ${[...sid].length}/${LIMIT}，单价 ¥${t.unitPrice}`)
      : bad(`档位 ${name}：${problems.join('；')}`);
  }
}

// ── ② 线上真实 402 里的实发值 ──────────────────────────────
step('② 线上真实 402 的实发值（跑一遍四个档位）');
const tiers = ['single', 'pack10', 'quest', 'trial'];
for (const tier of tiers) {
  const url = `${BASE}/api/v1/guide?scene=zjgsu-xiasha&query=%E6%B5%8B%E8%AF%95&tier=${tier}`;
  let res;
  try {
    res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(25000) });
  } catch (err) {
    bad(`档位 ${tier}：请求失败 ${err.message}`);
    continue;
  }
  if (res.status !== 402) { bad(`档位 ${tier}：期望 402，实际 ${res.status}`); continue; }

  const needed = res.headers.get('payment-needed');
  if (!needed) { bad(`档位 ${tier}：缺 Payment-Needed 头`); continue; }
  let decoded;
  try {
    decoded = JSON.parse(Buffer.from(needed, 'base64url').toString('utf8'));
  } catch (err) {
    bad(`档位 ${tier}：Payment-Needed 无法解码（${err.message}）`);
    continue;
  }
  const body = await res.json().catch(() => ({}));

  const p = decoded.protocol ?? {};
  const m = decoded.method ?? {};
  const checks = [
    ['out_trade_no', p.out_trade_no, LIMIT],
    ['goods_name', m.goods_name, LIMIT],
    ['service_id', m.service_id, LIMIT],
    ['amount', p.amount, LIMIT],
  ];
  const problems = [];
  for (const [field, value, limit] of checks) {
    const len = [...String(value ?? '')].length;
    if (!value) problems.push(`${field} 为空`);
    else if (len > limit) problems.push(`${field} ${len} > ${limit}`);
  }
  if (String(p.currency) !== 'CNY') problems.push(`currency 应为 CNY，实际 ${p.currency}`);
  if (p.seller_sign_type !== 'RSA2') problems.push(`seller_sign_type 应为 RSA2，实际 ${p.seller_sign_type}`);

  // 金额必须等于档位注册价（平台硬约束：注册价 ≠ 实收价 → 拒单）
  const svc = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'services.json'), 'utf8'));
  const declared = String(svc.tiers?.[tier]?.unitPrice ?? '');
  // 沙箱模式会把所有档位归一成 ¥0.01，所以只在生产模式比价
  if (process.env.CHECK_ENV === 'production' && String(p.amount) !== declared) {
    problems.push(`金额 ¥${p.amount} 与注册价 ¥${declared} 不一致`);
  }

  // pay_before 不得超过当前 12 小时
  const pb = Date.parse(p.pay_before);
  if (!Number.isFinite(pb)) problems.push('pay_before 无法解析');
  else {
    const hours = (pb - Date.now()) / 3600000;
    if (hours < 0) problems.push(`pay_before 已过期（${hours.toFixed(2)}h）`);
    else if (hours > MAX_PAY_BEFORE_HOURS) problems.push(`pay_before 超过当前 ${MAX_PAY_BEFORE_HOURS}h（${hours.toFixed(2)}h）`);
  }

  // 响应体的订单号必须与报文里的同一个
  if (body.out_trade_no && body.out_trade_no !== p.out_trade_no) {
    problems.push('响应体 out_trade_no 与 Payment-Needed 里的不一致');
  }

  problems.length === 0
    ? ok(`档位 ${tier}：out_trade_no ${[...String(p.out_trade_no)].length}/${LIMIT}，`
        + `goods_name ${[...String(m.goods_name)].length}/${LIMIT}，`
        + `service_id ${[...String(m.service_id)].length}/${LIMIT}，`
        + `¥${p.amount} ${p.currency}，pay_before ${((pb - Date.now()) / 60000).toFixed(0)} 分钟后`)
    : bad(`档位 ${tier}：${problems.join('；')}`);
}

// ── ③ 订单号形制的余量 ──────────────────────────────────────
step('③ 订单号形制余量');
{
  const sample = `SG_${Date.now()}_${'0'.repeat(12)}`;
  const len = [...sample].length;
  const headroom = LIMIT - len;
  headroom >= 3
    ? ok(`当前形制 ${len}/${LIMIT} 字符，余量 ${headroom}（改形制前先跑这项）`)
    : warn(`当前形制 ${len}/${LIMIT} 字符，余量仅 ${headroom}——再加前缀就会超限`);
}

console.log(`\n${failed ? R : G}${failed ? `失败 ${failed} 项` : '官方接口字段限额自检全部通过'}${N}`);
process.exit(failed ? 1 : 0);
