#!/usr/bin/env node
/**
 * 抓取一次真实的 402 协议往返，存成静态数据供站点展示。
 *
 * ⚠️ 存的是**真实发生的报文**（沙箱环境），不是手写的示意。
 *    站点在 API 不可用时会回落到这份快照，保证展示页永远不是空的。
 *
 * 用法：node scripts/capture-protocol-trace.js
 */
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3000';
const OUT = path.resolve(process.cwd(), 'public', 'data', 'protocol-trace.json');

function decodeBase64Url(value) {
  let v = String(value);
  while (v.length % 4) v += '=';
  return Buffer.from(v.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

async function main() {
  const query = '从A教学楼到C教学楼怎么走';
  const url = `${BASE}/api/v1/guide?scene=zjgsu-xiasha&query=${encodeURIComponent(query)}`;

  // 1. 首次请求 → 402 + Payment-Needed
  const first = await fetch(url);
  const paymentNeededRaw = first.headers.get('payment-needed');
  if (first.status !== 402 || !paymentNeededRaw) {
    throw new Error(`期望 402，实际 ${first.status}，Payment-Needed=${Boolean(paymentNeededRaw)}`);
  }
  const decoded = JSON.parse(decodeBase64Url(paymentNeededRaw));
  const challengeBody = await first.json();

  // 2. 沙箱收银 → Payment-Proof → 履约 → 交付
  const paid = await fetch(`${BASE}/api/v1/demo/pay`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scene: 'zjgsu-xiasha', query }),
  });
  const paidJson = await paid.json();
  if (paidJson.error) throw new Error(`支付失败：${paidJson.error}`);

  const trace = {
    capturedAt: new Date().toISOString(),
    env: 'sandbox',
    request: {
      method: 'GET',
      url: '/api/v1/guide?scene=zjgsu-xiasha&query=…',
    },
    step1_challenge: {
      status: 402,
      statusText: 'Payment Required',
      headerName: 'Payment-Needed',
      headerValuePreview: `${paymentNeededRaw.slice(0, 72)}…（共 ${paymentNeededRaw.length} 字符）`,
      decoded,
      body: challengeBody,
    },
    step2_payment: {
      cashierEndpoint: 'http://aicashier.dl.alipaydev.com/openclawpay/agent/v1/pay',
      buyerCommands: [
        'alipay-bot -- check-wallet',
        'alipay-bot -- 402-buyer-pay -f 402_needed_<timestamp>.txt',
      ],
      note: 'Payment-Needed 头原样交给买方技能，不解码、不改动',
    },
    step3_verify: {
      api: 'alipay.aipay.agent.payment.verify',
      bizContent: {
        payment_proof: '<Payment-Proof.protocol.payment_proof，由支付宝 CLI 生成>',
        trade_no: '<Payment-Proof.protocol.trade_no，32 位纯数字>',
        client_session: '<Payment-Proof.method.client_session，原样透传，不得修改或缓存>',
      },
      checks: ['active == true', 'amount 一致', 'out_trade_no 一致', 'resource_id 一致', 'trade_no 未重复履约'],
    },
    step4_fulfillment: {
      api: 'alipay.aipay.agent.fulfillment.confirm',
      bizContent: { trade_no: '<支付宝交易号>' },
      note: '履约回执失败时不得返回成功交付，应保留资源允许同一笔 Payment-Proof 重试',
    },
    step5_delivery: {
      status: 200,
      headerName: 'Payment-Validation',
      headerValuePreview: paidJson.paymentValidationPreview,
      body: {
        ...(paidJson.envelope ?? {}),
        content_preview: paidJson.content,
      },
    },
    order: {
      tradeNo: paidJson.tradeNo,
      payUrl: paidJson.payUrl,
    },
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(trace, null, 2));
  console.log(`✓ 已写入 ${OUT}`);
  console.log(`  tradeNo : ${trace.order.tradeNo}`);
  console.log(`  金额    : ¥${challengeBody.amount}`);
  console.log(`  交付    : ${trace.step5_delivery.body.resource_id}`);
}

main().catch((err) => {
  console.error(`✗ ${err.message}`);
  process.exit(1);
});
