#!/usr/bin/env node
/**
 * 官方预下单（amtPaymentLink）自检
 *
 * 为什么需要它：官方《MACHINE_PAY.md》给出的生产 402 形态是
 *   调 `alipay.aipay.agent.payment.precreate` → 拿 `amt_pre_pay_id` → 402 带 `amtPaymentLink` 头，
 * 但**官方没有公开完整响应 JSON**，只说「返回对象中包含 amt_pre_pay_id」。
 * 本脚本用生产密钥真调一次，把**原始响应**打出来，确认字段名与层级，
 * 再据此决定是否打开 config/production.json 的 precreate.enabled。
 *
 * 它同时验证 402 双形态是否真的都带上了两个头。
 *
 * 用法（需要 config/production.json 已填好真实密钥）：
 *   node scripts/prod/precreate-check.mjs
 *   BASE_URL=https://121.43.80.231/sceneguide node scripts/prod/precreate-check.mjs
 *
 * 退出码：0 通过 / 1 未通过
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
const warn = (m) => console.log(`  ${Y}! ${m}${N}`);
const step = (m) => console.log(`\n${C}▸ ${m}${N}`);

const prodFile = path.join(ROOT, 'config', 'production.json');

step('1. 生产配置');
if (!fs.existsSync(prodFile)) {
  bad('config/production.json 不存在——先从 config/production.template.json 复制并填入真实密钥');
} else {
  const prod = JSON.parse(fs.readFileSync(prodFile, 'utf8'));
  const need = ['appId', 'alipayPublicKey', 'privateKey', 'sellerId'];
  const missing = need.filter((k) => !prod[k] || /FILL_ME/.test(String(prod[k])));
  if (missing.length) bad(`缺少字段：${missing.join(' / ')}`);
  else ok('生产密钥齐全');

  step('2. 调用官方预下单接口');
  // 动态 import 服务端模块，复用同一套签名与请求封装
  const { createAlipayClient } = await import('../../src/a2m/client.js');
  const { toPem } = await import('../../src/a2m/protocol.js');
  void toPem;

  // 🔴 档位必须取**生产覆盖层**（config/services.production.json，经 loadServices 合成），
  //    不能直接读 services.json——基础表的 serviceId 恒为沙箱占位符，
  //    旧实现会误报「还是沙箱占位符」并中止真实预下单实测（2026-11-28 修正）。
  const svcMod = await import('../../src/config.js');
  const tiers = svcMod.loadServices({ env: 'production' });
  const tierName = process.env.TIER ?? Object.keys(tiers)[0];
  const tier = tiers[tierName];
  if (!tier) bad('没有可用档位（生产覆盖层为空）');
  else {
    if (String(tier.serviceId) === 'api_mock_service_id') {
      bad(`档位 ${tierName} 的 serviceId 还是沙箱占位符——预下单必须用生产 service_id`);
    } else {
      ok(`档位 ${tierName}：serviceId=${tier.serviceId} 单价 ¥${tier.unitPrice}`);
      const client = createAlipayClient({
        appId: prod.appId,
        privateKeyB64: prod.privateKey,
        alipayPublicKey: prod.alipayPublicKey,
        gateway: prod.gateway ?? 'https://openapi.alipay.com/gateway.do',
      });
      const outTradeNo = `SG_CHECK_${Date.now()}_PRECREATE`;
      const res = await client.precreate({
        outTradeNo,
        serviceId: tier.serviceId,
        goodsName: `${tier.label} · 三维场景导览`,
        amount: String(tier.productionPrice ?? tier.unitPrice),
        payBefore: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        currency: 'CNY',
        memo: '预下单自检',
      });
      if (res.ok) {
        ok(`预下单成功，amt_pre_pay_id = ${res.amtPrePayId}`);
        console.log(`      原始响应片段：${res.raw}`);
      } else {
        bad(`预下单失败：${res.errorCode} ${res.errorMessage}`);
        if (res.raw) console.log(`      原始响应：${res.raw}`);
        console.log('      ⚠️ 官方未公开该接口的完整错误语义，按 sub_code/sub_msg 对照官方文档排查');
      }
    }
  }
}

step('3. 线上 402 挑战的响应头');
if (BASE) {
  try {
    const guide = await fetch(
      `${BASE}/api/v1/guide?scene=zjgsu-xiasha&query=%E4%BB%8E%E5%9B%BE%E4%B9%A6%E9%A6%86%E5%88%B0%E8%A1%8C%E6%94%BF%E6%A5%BC%E6%80%8E%E4%B9%88%E8%B5%B0`,
      { redirect: 'manual', signal: AbortSignal.timeout(20000) },
    );
    if (guide.status !== 402) bad(`未拿到 402（实际 ${guide.status}）`);
    else {
      ok('402 挑战已返回');
      const needed = guide.headers.get('payment-needed');
      const amtLink = guide.headers.get('amtpaymentlink');
      const precreateState = guide.headers.get('x-sg-precreate');
      needed ? ok('Payment-Needed 头存在（Agent 买方路径）') : bad('缺少 Payment-Needed 头');
      if (amtLink) ok(`amtPaymentLink 头存在：${amtLink}（官方预下单路径）`);
      else warn(`未出现 amtPaymentLink（precreate 状态：${precreateState ?? '未启用/未配置'}）——这是预期，除非已打开 precreate.enabled`);
    }
  } catch (err) {
    bad(`实例不可达：${err.message}`);
  }
}

console.log(`\n${failed ? R : G}${failed ? `有 ${failed} 项未通过` : '全部通过'}${N}`);
process.exit(failed ? 1 : 0);
