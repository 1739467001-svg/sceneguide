#!/usr/bin/env node
/**
 * 生产切换自检（prod-check）
 *
 * 为什么要它：切生产是本次参赛**唯一的关键路径**，而它有 5 个必须同时成立的
 * 前置条件，任何一个不满足都会在评审现场变成事故：
 *
 *   ① config/production.json 存在且 appId / 支付宝公钥 / 应用私钥齐全
 *   ② 应用私钥是 **PKCS#1**（alipay-sdk 只吃 PKCS#1，PKCS#8 会报
 *      DECODER routines::unsupported——本项目 11 月已实测踩过）
 *   ③ seller_id 是 2088 格式，且**等于 PAYATHON 报名账号的 PID**
 *      （官方细则硬性要求：报名账号必须与接入 AI 付产品的账号为同一账号，
 *        不一致时「商业化成熟度」按报名账户口径统计 → 直接计 0）
 *   ④ services.json 里**每个档位**的 serviceId 都是真实值（不是 api_mock_service_id），
 *      且 unitPrice 与支付宝服务市场注册价**完全一致**
 *      （平台硬约束：不一致时收银返回 SERVICE_PRICE_MISMATCH 拒单）
 *   ⑤ 线上 /healthz 报 env=production，且 402 挑战里的 service_id 是真实值
 *
 * 用法：
 *   node scripts/prod-check.mjs              # 检查本地配置
 *   BASE_URL=http://127.0.0.1:3000 node scripts/prod-check.mjs   # 连带检查运行中的实例
 *   BASE_URL=https://121.43.80.231/sceneguide node scripts/prod-check.mjs
 *
 * 退出码：0 全部通过 / 1 有阻塞项
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = (process.env.BASE_URL ?? '').replace(/\/$/, '');

const G = '\x1b[32m', R = '\x1b[31m', Y = '\x1b[33m', C = '\x1b[36m', N = '\x1b[0m';
let failed = 0;
let warned = 0;

const ok = (m) => console.log(`  ${G}✓${N} ${m}`);
const bad = (m) => { console.log(`  ${R}✗ ${m}${N}`); failed += 1; };
const warn = (m) => { console.log(`  ${Y}! ${m}${N}`); warned += 1; };
const step = (m) => console.log(`\n${C}▸ ${m}${N}`);

const readJson = (f) => {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); }
  catch { return null; }
};

const prodFile = path.join(ROOT, 'config', 'production.json');
const servicesFile = path.join(ROOT, 'config', 'services.json');

// ── 1. 生产配置文件 ────────────────────────────────────────────
step('1. 生产配置文件 config/production.json');
const prod = readJson(prodFile);
if (!prod) {
  bad('文件不存在——请从 config/production.template.json 复制并填入真实值');
} else {
  const need = ['appId', 'alipayPublicKey', 'privateKey', 'sellerId'];
  const missing = need.filter((k) => !prod[k] || /FILL_ME/.test(String(prod[k])));
  if (missing.length) bad(`缺少或仍是占位符：${missing.join(' / ')}`);
  else ok('四个必需字段齐全');

  // ② 私钥格式
  const pk = String(prod.privateKey ?? '');
  if (pk.includes('BEGIN PRIVATE KEY') && !pk.includes('BEGIN RSA PRIVATE KEY')) {
    bad('应用私钥是 PKCS#8（BEGIN PRIVATE KEY）——alipay-sdk 只吃 PKCS#1，会报 DECODER routines::unsupported');
  } else if (pk.includes('BEGIN RSA PRIVATE KEY')) {
    ok('应用私钥为 PKCS#1（BEGIN RSA PRIVATE KEY）');
  } else {
    // 可能是裸 base64 —— 无法从形态判定，交给运行期报错
    warn('私钥看起来是裸 base64，无法静态判定格式；若启动报 DECODER 错误，改用 PKCS#1');
  }

  // ③ seller_id 格式与一致性
  const seller = String(prod.sellerId ?? '');
  if (!/^2088\d+$/.test(seller)) bad(`sellerId 不是 2088 格式：${seller}`);
  else ok(`sellerId 格式正确（${seller.slice(0, 8)}…）`);

  const expectedPid = process.env.PAYATHON_PID ?? '';
  if (expectedPid) {
    if (seller === expectedPid) ok(`sellerId 与 PAYATHON 报名账号 PID 一致（${expectedPid}）`);
    else bad(`sellerId（${seller}）与 PAYATHON 报名账号 PID（${expectedPid}）不一致——商业化维度会直接计 0`);
  } else {
    warn('未提供 PAYATHON_PID 环境变量，跳过「与报名账号一致性」检查');
  }

  // 网关
  if (prod.gateway && prod.gateway.includes('sandbox')) bad('gateway 仍指向沙箱网关');
  else ok(`gateway：${prod.gateway ?? 'https://openapi.alipay.com/gateway.do（默认）'}`);
}

// ── 2. 档位表 ─────────────────────────────────────────────────
// ⚠️ 必须查**合并后的有效配置**，不能只看 config/services.json：
//    生产 service_id 现在放在 .gitignore 的覆盖层 config/services.production.json 里
//    （原因：services.json 被 git 跟踪且沙箱共用，写真实 id 会把沙箱收银弄挂）。
//    2026-11-24 实测：不合并就查会误报「仍是沙箱占位符」，而线上其实是就绪的。
step('2. 服务档位（档位表 + 生产 service_id 覆盖层）');
const svc = readJson(servicesFile);
const idsFile = path.join(ROOT, 'config', 'services.production.json');
const idsOverlay = fs.existsSync(idsFile) ? (readJson(idsFile)?.tiers ?? {}) : {};
const baseTiers = svc?.tiers ?? {};
const tierNames = Object.keys(baseTiers);
if (!tierNames.length) {
  bad('没有档位');
} else {
  for (const [name, t] of Object.entries(baseTiers)) {
    const ov = idsOverlay[name] ?? {};
    const sid = String(ov.serviceId ?? t.serviceId ?? '');
    const price = String(ov.unitPrice ?? t.unitPrice ?? '');
    if (sid === 'api_mock_service_id') bad(`档位 ${name} 的 serviceId 仍是沙箱占位符`);
    else if (!sid) bad(`档位 ${name} 缺少 serviceId`);
    else ok(`档位 ${name}：serviceId=${sid.slice(0, 18)}… 单价 ¥${price}${ov.serviceId ? '（覆盖层）' : ''}`);

    if (!/^\d+(\.\d{1,2})?$/.test(price)) bad(`档位 ${name} 单价格式非法：${price}`);
    else if (Number(price) < 0.01 || Number(price) > 50) bad(`档位 ${name} 单价超出 0.01–50 元：${price}`);
  }
  // 注册服务数量上限（试运行期 10 个）
  if (tierNames.length > 10) bad(`档位数 ${tierNames.length} 超过试运行期上限 10 个`);
  else ok(`档位数 ${tierNames.length}（上限 10）`);
}

// ── 3. 运行中的实例 ───────────────────────────────────────────
if (BASE) {
  step(`3. 运行中的实例 ${BASE}`);
  try {
    const res = await fetch(`${BASE}/healthz`, { signal: AbortSignal.timeout(15000) });
    const health = await res.json();
    console.log(`      env=${health.env}  appId=${health.appId}  sellerId=${health.sellerId}`);
    console.log(`      db=${JSON.stringify(health.db)}`);

    if (health.env !== 'production') {
      warn(`实例仍是 ${health.env} 环境——真实交易不会计入「商业化成熟度」统计`);
    } else {
      ok('实例运行在生产环境');
    }

    // ⑤ 402 挑战里的 service_id 必须是真实值
    const guide = await fetch(
      `${BASE}/api/v1/guide?scene=zjgsu-xiasha&query=%E4%BB%8E%E5%9B%BE%E4%B9%A6%E9%A6%86%E5%88%B0%E8%A1%8C%E6%94%BF%E6%A5%BC%E6%80%8E%E4%B9%88%E8%B5%B0`,
      { redirect: 'manual', signal: AbortSignal.timeout(20000) },
    );
    if (guide.status === 402) {
      const needed = guide.headers.get('payment-needed');
      if (!needed) bad('402 响应缺少 Payment-Needed 头');
      else {
        const decoded = JSON.parse(Buffer.from(needed, 'base64url').toString('utf8'));
        const sid = decoded?.method?.service_id;
        const amount = decoded?.protocol?.amount;
        if (sid === 'api_mock_service_id') bad(`402 挑战里的 service_id 仍是沙箱占位符（${sid}）`);
        else ok(`402 挑战携带真实 service_id：${sid}`);
        console.log(`      挑战金额 ¥${amount}（必须与服务市场注册价一致，否则 SERVICE_PRICE_MISMATCH 拒单）`);
      }
    } else {
      bad(`未拿到 402 支付挑战（实际 ${guide.status}）`);
    }
  } catch (err) {
    bad(`实例不可达或探活失败：${err.message}`);
  }
} else {
  console.log(`\n${Y}（未提供 BASE_URL，跳过运行实例检查）${N}`);
}

console.log(`\n${failed ? R : G}${failed ? `有 ${failed} 项阻塞` : '全部通过'}${N}${warned ? `（另有 ${warned} 项提醒）` : ''}`);
process.exit(failed ? 1 : 0);
