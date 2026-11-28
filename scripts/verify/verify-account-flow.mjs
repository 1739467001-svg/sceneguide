#!/usr/bin/env node
/**
 * 买家账户中心全流程验收
 *
 * 覆盖「付完钱之后」的完整生命周期——这是商业化演示里最常缺失的一段：
 *
 *   1. 买「十次导览包」（沙箱一键支付）        → 10 次额度到账，本次交付扣 1 次
 *   2. 生成礼品码（花 1 次额度）              → 余额再扣 1 次
 *   3. 另一个访客兑换礼品码                   → 对方拿到 1 次额度（增长回路）
 *   4. 新访客直接问路                          → 从余额扣减交付，不再发起支付
 *   5. 撤销未兑换的礼品码                      → 额度还给赠予者
 *   6. 申请退款                                → 权益回收 + 订单标注（沙箱口径）
 *
 * 用法：node scripts/verify/verify-account-flow.mjs
 *       BASE_URL=http://121.43.80.231/sceneguide node scripts/verify/verify-account-flow.mjs
 */

const BASE = (process.env.BASE_URL ?? 'http://127.0.0.1:3000').replace(/\/$/, '');

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const CYAN = '\x1b[36m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

let passed = 0;
let failed = 0;
const ok = (msg) => { passed += 1; console.log(`  ${GREEN}✓${RESET} ${msg}`); };
const bad = (msg) => { failed += 1; console.log(`  ${RED}✗ ${msg}${RESET}`); };
const step = (msg) => console.log(`\n${CYAN}▸ ${msg}${RESET}`);

const VISITOR_A = `acct-a-${Date.now().toString(36)}`;
const VISITOR_B = `acct-b-${Date.now().toString(36)}`;
const cookie = (v) => `sg_vid=${v}`;

async function api(path, { method = 'GET', body, visitor } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(visitor ? { Cookie: cookie(visitor) } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(60000),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

async function main() {
  console.log('三维问路 · SceneGuide —— 买家账户中心全流程验收');
  console.log(`目标：${BASE}`);

  step('0. 运行环境');
  const health = await api('/healthz');
  if (!health.json?.ok) { bad('/healthz 不可达'); return finish(); }
  ok(`env=${health.json.env}`);
  const isSandbox = health.json.env === 'sandbox';
  if (!isSandbox) {
    console.log(`${DIM}正式环境：跳过支付段（真实收银必须由买家本人确认）${RESET}`);
  }

  if (isSandbox) {
    step('1. 购买「十次导览包」（沙箱一键支付）');
    const buy = await api('/api/v1/demo/pay', {
      method: 'POST',
      visitor: VISITOR_A,
      body: {
        scene: 'zjgsu-xiasha',
        query: '从A教学楼到C教学楼怎么走',
        mode: 'guide',
        tier: 'pack10',
      },
    });
    if (buy.status !== 200 || !buy.json?.content?.answer) {
      bad(`购买失败：HTTP ${buy.status} ${JSON.stringify(buy.json).slice(0, 200)}`);
      return finish();
    }
    ok('支付完成并当场交付（十次包：10 次额度到账，本次扣 1 次）');
  }

  step('2. 我的账户：订单与额度');
  const meA = await api('/api/v1/me', { visitor: VISITOR_A });
  const entA = meA.json?.entitlements ?? {};
  const packOrder = (meA.json?.orders ?? []).find((o) => o.tier === 'pack10' && o.fulfillStatus === 'FULFILLED');
  if (isSandbox) {
    if ((entA.remaining ?? 0) === 9) ok('额度余额 = 9（10 发放 − 1 本次交付）');
    else bad(`额度余额应为 9，实际 ${entA.remaining}`);
    if (packOrder) ok('订单列表含该笔十次包（已交付）');
    else bad('订单列表缺少十次包订单');
  }

  step('3. 生成礼品码（花 1 次额度）');
  const gen = await api('/api/v1/gifts', { method: 'POST', visitor: VISITOR_A, body: {} });
  if (gen.status !== 200 || !gen.json?.code) {
    bad(`生成失败：${JSON.stringify(gen.json).slice(0, 160)}`);
    return finish();
  }
  const giftCode = gen.json.code;
  ok(`礼品码 ${giftCode} 已生成`);
  if (isSandbox) {
    if ((gen.json.remaining ?? -1) === 8) ok('生成后余额 = 8');
    else bad(`生成后余额应为 8，实际 ${gen.json.remaining}`);
  }

  step('4. 另一个访客兑换礼品码');
  const redeem = await api('/api/v1/gifts/redeem', {
    method: 'POST', visitor: VISITOR_B, body: { code: giftCode },
  });
  if (redeem.status !== 200) {
    bad(`兑换失败：${JSON.stringify(redeem.json).slice(0, 160)}`);
  } else {
    ok('兑换成功，接收方拿到 1 次额度');
  }
  const meB = await api('/api/v1/me', { visitor: VISITOR_B });
  if ((meB.json?.entitlements?.remaining ?? 0) === 1) ok('接收方余额 = 1');
  else bad(`接收方余额应为 1，实际 ${meB.json?.entitlements?.remaining}`);

  step('5. 接收方免支付问路（从余额扣减）');
  const free = await fetch(
    `${BASE}/api/v1/guide?scene=zjgsu-xiasha&query=${encodeURIComponent('从A教学楼到C教学楼怎么走')}`,
    { headers: { Cookie: cookie(VISITOR_B) }, signal: AbortSignal.timeout(30000) },
  );
  if (free.status === 200) {
    const body = await free.json().catch(() => ({}));
    ok('HTTP 200：不再发起 402 支付挑战（余额扣减）');
    if (body?.content?.answer) ok('返回完整导览答案');
    else bad('响应缺少答案');
  } else {
    bad(`期望 200，实际 ${free.status}`);
  }
  const meB2 = await api('/api/v1/me', { visitor: VISITOR_B });
  if ((meB2.json?.entitlements?.remaining ?? -1) === 0) ok('扣减后接收方余额 = 0');
  else bad(`扣减后余额应为 0，实际 ${meB2.json?.entitlements?.remaining}`);

  step('6. 撤销未兑换的礼品码 → 额度还给赠予者');
  const gen2 = await api('/api/v1/gifts', { method: 'POST', visitor: VISITOR_A, body: {} });
  if (gen2.status !== 200) {
    bad(`再生成一个礼品码失败：${JSON.stringify(gen2.json).slice(0, 160)}`);
  } else {
    const revoke = await api('/api/v1/gifts/revoke', {
      method: 'POST', visitor: VISITOR_A, body: { code: gen2.json.code },
    });
    if (revoke.status === 200 && (revoke.json?.entitlements?.remaining ?? -1) === 8) {
      ok('撤销成功，赠予者余额回到 8');
    } else {
      bad(`撤销后余额应为 8，实际 ${revoke.json?.entitlements?.remaining}`);
    }
  }

  step('7. 申请退款（沙箱口径：权益回收 + 工单 + 标注）');
  if (!packOrder) {
    console.log(`${DIM}  没有可退的十次包订单（正式环境），跳过${RESET}`);
  } else {
    const refund = await api('/api/v1/refunds', {
      method: 'POST', visitor: VISITOR_A,
      body: { out_trade_no: packOrder.outTradeNo, reason: '验收脚本自测' },
    });
    if (refund.status !== 200) {
      bad(`退款失败：${JSON.stringify(refund.json).slice(0, 160)}`);
    } else {
      ok('退款受理：订单标注已退 + 工单留痕');
      const meA2 = await api('/api/v1/me', { visitor: VISITOR_A });
      const refunded = (meA2.json?.orders ?? []).find((o) => o.outTradeNo === packOrder.outTradeNo);
      if (refunded?.refundStatus === 'REFUNDED') ok('订单状态 = REFUNDED');
      else bad(`订单 refund_status 异常：${refunded?.refundStatus}`);
      // 整包退款收回的是「该包台账的剩余次数」；撤销礼品码返还的那 1 次是独立台账，
      // 不属于这个包，因此总余额应为 1（而不是 0）——分别断言才说得清
      const ledgers = meA2.json?.entitlements?.entitlements ?? [];
      const packLedger = ledgers.find((e) => e.tier === 'pack10');
      if (packLedger && packLedger.remaining === 0) ok('整包台账剩余次数清零（quota=used）');
      else bad(`整包台账剩余应为 0，实际 ${packLedger?.remaining}`);
      const giftBack = ledgers.find((e) => e.tier !== 'pack10');
      if ((meA2.json?.entitlements?.remaining ?? -1) === 1 && giftBack?.remaining === 1) {
        ok('总余额 = 1（来自撤销礼品码的返还，独立台账）');
      } else {
        bad(`总余额应为 1，实际 ${meA2.json?.entitlements?.remaining}`);
      }
    }
    // 重复退款必须被拒
    const again = await api('/api/v1/refunds', {
      method: 'POST', visitor: VISITOR_A, body: { out_trade_no: packOrder.outTradeNo },
    });
    if (again.status === 400) ok('重复退款被拒（幂等保护）');
    else bad(`重复退款应被拒，实际 HTTP ${again.status}`);
  }

  finish();
}

function finish() {
  console.log('\n────────────────────────────────────────────────────────');
  if (failed === 0) {
    console.log(`${GREEN}买家账户中心全部通过：${passed} 项${RESET}`);
    process.exit(0);
  }
  console.log(`${RED}失败 ${failed} 项 / 通过 ${passed} 项${RESET}`);
  process.exit(1);
}

main().catch((err) => {
  console.error(`\n${RED}脚本异常：${err.message}${RESET}`);
  process.exit(1);
});
