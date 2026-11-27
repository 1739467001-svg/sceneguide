#!/usr/bin/env node
/**
 * 生产切换一条龙（prod-cutover）
 *
 * 为什么要有这个脚本（2026-11-24）：
 *   切生产是整条链上**唯一不可逆**的一步——一旦 ALIPAY_ENV=production 生效，
 *   线上收银就开始走真实网关与真实 service_id，任何一处填错（金额对不上、
 *   私钥格式不对、sellerId 不是报名账号）都表现为**每一笔支付被拒**，
 *   而不是启动失败。到那时在截止日前很难查清。
 *
 *   所以这一步的每一个环节都必须**机械可核对**：填错一个字符应该由脚本拦下来，
 *   而不是由评委在决赛现场发现。
 *
 * 它做什么（按顺序，每步都有闸门）：
 *   ① 读取并体检生产配置（**私钥只验格式、不打印、不外传**）
 *   ② 校验四档 service_id 覆盖层与真实注册价一一对应
 *   ③ 跑 prod-check 闸门（5 项阻塞清单）
 *   ④ 把生产配置放到服务器（scp 到权威位置，仓库里永远不出现）
 *   ⑤ 幂等地给服务器 compose 加上 ALIPAY_ENV=production
 *   ⑥ 部署 + 重建容器 + 健康检查
 *   ⑦ 线上复验：402 挑战里必须带**真实 service_id**，且价格与注册价一致
 *
 * 🔴 私钥边界（官方 skill 的红线 P-KEY-NO-PRIVATE）：
 *   私钥**由用户自己**填进 config/production.json（该文件已 gitignore）。
 *   本脚本只做格式体检（PKCS#1 可解析），**从不打印、从不写日志、从不回显**。
 *
 * 用法：
 *   node scripts/prod-cutover.mjs --check          # 只做本地体检，不动线上
 *   node scripts/prod-cutover.mjs --apply          # 体检 → 部署 → 切生产 → 线上复验
 *   node scripts/prod-cutover.mjs --apply --dry    # 体检 + 打印将要做的动作，不执行
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOST = process.env.SG_DEPLOY_HOST ?? 'aliyun';
const APP_DIR = '/srv/apps/sceneguide';
const BASE = (process.env.BASE_URL ?? 'https://121.43.80.231/sceneguide').replace(/\/$/, '');

const G = '\x1b[32m', R = '\x1b[31m', Y = '\x1b[33m', C = '\x1b[36m', N = '\x1b[0m';
let failed = 0;
const ok = (m) => console.log(`  ${G}✓${N} ${m}`);
const bad = (m) => { console.log(`  ${R}✗ ${m}${N}`); failed += 1; };
const warn = (m) => console.log(`  ${Y}!${N} ${m}`);
const step = (m) => console.log(`\n${C}▸ ${m}${N}`);

const APPLY = process.argv.includes('--apply');
const DRY = process.argv.includes('--dry');

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
}

// ── ① 生产配置体检 ──────────────────────────────────────────
step('① 生产配置 config/production.json');
const prodFile = path.join(ROOT, 'config', 'production.json');
let prod = null;
if (!fs.existsSync(prodFile)) {
  bad('缺少 config/production.json（该文件已 gitignore，需你本地创建后填入）');
  console.log('      模板：config/production.template.json');
} else {
  prod = JSON.parse(fs.readFileSync(prodFile, 'utf8'));
  const need = ['appId', 'alipayPublicKey', 'privateKey', 'sellerId'];
  const missing = need.filter((k) => {
    const v = String(prod[k] ?? '').trim();
    return !v || v === 'FILL_ME' || v.startsWith('FILL_ME');
  });
  if (missing.length) bad(`生产配置缺项或仍是占位：${missing.join('、')}`);
  else ok('四项必填齐全');

  if (prod.appId && !/^\d{16}$/.test(String(prod.appId).trim())) {
    bad(`appId 形制不对（应为 16 位数字，实际 ${String(prod.appId).trim().length} 位）`);
  } else if (prod.appId) ok(`appId 形制正确（${String(prod.appId).trim().slice(0, 4)}…）`);

  // 🔴 私钥只验「能不能解析」，绝不打印内容
  if (prod.privateKey) {
    try {
      const { parsePrivateKey } = await import('../src/a2m/protocol.js');
      const key = parsePrivateKey(String(prod.privateKey).trim());
      const pkcs1 = key.export({ type: 'pkcs1', format: 'pem' }).startsWith('-----BEGIN RSA PRIVATE KEY-----');
      pkcs1
        ? ok('应用私钥可解析，且是 PKCS#1（Node 侧必须是 PKCS#1，PKCS#8 会报 DECORODER 错）')
        : bad('应用私钥不是 PKCS#1 格式（Node 侧必须 PKCS#1）');
    } catch (err) {
      bad(`应用私钥无法解析：${err.message}（内容未打印）`);
    }
  }

  if (prod.alipayPublicKey) {
    const pk = String(prod.alipayPublicKey).trim();
    const clean = pk.replace(/-----(BEGIN|END) PUBLIC KEY-----/g, '').replace(/\s+/g, '');
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(clean)) bad('支付宝公钥不是合法的 Base64');
    else ok('支付宝公钥形制正确（单行 Base64）');
    if (/支付宝公钥|应用公钥/.test(pk)) warn('支付宝公钥字段里出现了中文标注——只应填 Base64 正文');
  }

  // sellerId 必须与报名账号一致（官方口径：实人认证的支付宝账户）
  if (prod.sellerId) {
    const sid = String(prod.sellerId).trim();
    if (!/^2088\d{12,}$/.test(sid)) bad(`sellerId 形制不对（应为 2088 开头的商户 PID）`);
    else if (sid !== '2088032169158784') bad(`sellerId(${sid}) 与 PAYATHON 报名账号的 PID(2088032169158784) 不一致——商业化维度会直接为 0`);
    else ok('sellerId 与报名账号一致（2088032169158784）');
  }

  if (prod.gateway && String(prod.gateway).includes('sandbox')) bad('gateway 仍指向沙箱网关');
}

// ── ② service_id 覆盖层与注册价一致性 ───────────────────────
step('② 四档 service_id 覆盖层');
const idsFile = path.join(ROOT, 'config', 'services.production.json');
const base = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'services.json'), 'utf8'));
if (!fs.existsSync(idsFile)) {
  bad('缺少 config/services.production.json（生产 service_id 覆盖层，已 gitignore）');
} else {
  const overlay = JSON.parse(fs.readFileSync(idsFile, 'utf8')).tiers ?? {};
  for (const [name, tier] of Object.entries(base.tiers ?? {})) {
    const ov = overlay[name];
    if (!ov?.serviceId) { bad(`档位 ${name} 缺 serviceId`); continue; }
    if (!/^API_[A-Z0-9]+$/.test(ov.serviceId)) { bad(`档位 ${name} 的 serviceId 形制不对：${ov.serviceId}`); continue; }
    const price = String(ov.unitPrice ?? tier.unitPrice);
    if (price !== String(tier.unitPrice)) {
      bad(`档位 ${name} 覆盖层单价 ${price} 与档位表 ${tier.unitPrice} 不一致`);
      continue;
    }
    ok(`档位 ${name}：${ov.serviceId}  ¥${price}`);
  }
  // 注册价必须与实际扣费价一致（平台硬约束，不一致直接 SERVICE_PRICE_MISMATCH）
  const svc = await import('../src/config.js');
  try {
    const prodTiers = svc.loadServices({ env: 'production' });
    for (const [name, t] of Object.entries(prodTiers)) {
      const id = String(t.serviceId);
      if (id === 'api_mock_service_id') bad(`生产档位 ${name} 仍是沙箱占位符`);
      else if (t.productionPrice !== t.unitPrice) bad(`档位 ${name} 生产价被改动（注册价 ${t.productionPrice} vs 扣费 ${t.unitPrice}）`);
    }
    ok('生产档位加载通过：service_id 均为真实值，且扣费价 = 注册价');
  } catch (err) {
    bad(`生产档位加载失败：${err.message}`);
  }
}

// ── ③ 沙箱不受影响 ─────────────────────────────────────────
step('③ 沙箱路径未被污染');
try {
  const svc = await import('../src/config.js');
  const sandbox = svc.loadServices({ env: 'sandbox' });
  const polluted = Object.entries(sandbox).filter(([, t]) => String(t.serviceId) !== 'api_mock_service_id');
  polluted.length === 0
    ? ok('沙箱仍是 api_mock_service_id + ¥0.01（本地验收与线上沙箱演示不受影响）')
    : bad(`沙箱被污染：${polluted.map(([k, t]) => `${k}=${t.serviceId}`).join('、')}`);
} catch (err) {
  bad(`沙箱档位加载失败：${err.message}`);
}

// ── ④ prod-check 闸门 ───────────────────────────────────────
step('④ prod-check 闸门');
try {
  const out = run('node', [path.join(ROOT, 'scripts', 'prod-check.mjs')], { cwd: ROOT });
  const clean = !/有 \d+ 项阻塞/.test(out);
  clean ? ok('prod-check 全绿（无阻塞项）') : bad('prod-check 仍有阻塞项');
} catch (err) {
  const out = `${err.stdout ?? ''}${err.stderr ?? ''}`;
  if (/有 \d+ 项阻塞/.test(out)) bad('prod-check 仍有阻塞项（见 scripts/prod-check.mjs 输出）');
  else bad(`prod-check 执行异常：${err.message}`);
}

if (!APPLY) {
  console.log(`\n${failed ? R : G}${failed ? `体检未通过：${failed} 项` : '体检通过（未执行切换，用 --apply 生效）'}${N}`);
  process.exit(failed ? 1 : 0);
}
if (failed) {
  console.log(`\n${R}体检未通过，已中止——不切生产${N}`);
  process.exit(1);
}

// ── ⑤ 打开官方预下单形态 + 放置生产配置到服务器 ────────────
// 官方 MACHINE_PAY.md「手动集成（传统）」第一条原文：
//   「用户未支付时，调用支付宝预下单接口，并返回 402 Payment Required
//     和包含预下单号的 amtPaymentLink 响应头。」
// ⇒ 预下单是官方**手动集成路径的第一步**，不是可选装饰。
//   我们的实现已就位且**优雅降级**（precreate 失败只降级为本地签名账单，
//   402 照样发得出去），所以切生产时应该一并打开；不打开的代价是
//   走官方支付能力的买方拿不到 amtPaymentLink。
step('⑤ 打开官方预下单形态（amtPaymentLink）');
if (DRY) {
  warn('DRY：将会把 config/production.json 的 precreate.enabled 置为 true');
} else if (!prod.precreate || prod.precreate.enabled !== true) {
  try {
    const cfg = JSON.parse(fs.readFileSync(prodFile, 'utf8'));
    cfg.precreate = {
      ...(cfg.precreate ?? {}),
      enabled: true,
      _comment: '2026-11-27 由 scripts/prod-cutover.mjs 打开：官方手动集成流程的第一步。'
        + '预下单失败会优雅降级为本地签名的 Payment-Needed，402 始终发得出去。',
    };
    fs.writeFileSync(prodFile, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
    ok('precreate.enabled = true（失败会自动降级为本地签名账单）');
  } catch (err) {
    bad(`打开预下单失败：${err.message}`);
  }
} else {
  ok('precreate.enabled 已经是 true');
}

step('⑤b 放置生产配置到服务器（仓库里永远不出现）');
if (DRY) {
  warn(`DRY：将会 scp config/production.json → ${HOST}:${APP_DIR}/app/config/production.json`);
} else {
  try {
    run('scp', ['-q', prodFile, `${HOST}:${APP_DIR}/app/config/production.json`]);
    ok('生产配置已放到服务器权威位置');
  } catch (err) {
    bad(`scp 失败：${err.message}`);
  }
}

// ── ⑥ compose 加 ALIPAY_ENV（幂等）─────────────────────────
step('⑥ 服务器 compose 切到 ALIPAY_ENV=production');
if (DRY) {
  warn(`DRY：将会给 ${HOST}:${APP_DIR}/docker-compose.yml 增加 ALIPAY_ENV: production`);
} else {
  try {
    const cmd = `cd ${APP_DIR} && grep -q 'ALIPAY_ENV' docker-compose.yml || sed -i.bak 's/^      NODE_ENV: production$/      NODE_ENV: production\\n      ALIPAY_ENV: production/' docker-compose.yml`;
    run('ssh', [HOST, cmd]);
    const check = run('ssh', [HOST, `grep -c 'ALIPAY_ENV: production' ${APP_DIR}/docker-compose.yml || true`]);
    Number(check.trim()) > 0 ? ok('compose 已设置 ALIPAY_ENV=production') : bad('compose 未见 ALIPAY_ENV=production');
  } catch (err) {
    bad(`修改 compose 失败：${err.message}`);
  }
}

// ── ⑦ 部署 + 健康检查 ──────────────────────────────────────
step('⑦ 部署与健康检查');
if (DRY) {
  warn('DRY：跳过部署');
} else {
  try {
    const out = run('bash', [path.join(ROOT, 'deploy', 'deploy.sh')], {
      cwd: ROOT,
      env: { ...process.env, TARGET: HOST },
    });
    ok(out.trim().split('\n').slice(-3).join(' / '));
  } catch (err) {
    const out = `${err.stdout ?? ''}${err.stderr ?? ''}`;
    bad(`部署失败：${out.trim().split('\n').slice(-4).join(' / ')}`);
  }
}

// ── ⑧ 线上复验：402 必须带真实 service_id ───────────────────
step('⑧ 线上复验（402 挑战必须带真实 service_id）');
try {
  const res = await fetch(`${BASE}/api/v1/guide?scene=demo-park&query=%E6%B5%8B%E8%AF%95`, {
    redirect: 'manual',
    signal: AbortSignal.timeout(25000),
  });
  const needed = res.headers.get('payment-needed');
  if (res.status !== 402) bad(`期望 402，实际 ${res.status}`);
  else ok('402 支付挑战正常');
  if (!needed) bad('缺 Payment-Needed 头');
  else {
    const decoded = JSON.parse(Buffer.from(needed, 'base64url').toString('utf8'));
    const sid = decoded?.method?.service_id ?? '';
    const amount = decoded?.protocol?.amount;
    if (sid && sid !== 'api_mock_service_id') ok(`402 携带真实 service_id（${sid}），金额 ¥${amount}`);
    else bad(`402 仍带沙箱 service_id（${sid || '空'}）——生产未真正生效`);
    // 官方手动集成流程第一步：402 必须同时带 amtPaymentLink（预下单号）。
    // 拿不到不算致命（实现会优雅降级），但要走官方支付能力的买方就没有这条路了。
    const amtLink = res.headers.get('amtpaymentlink');
    if (amtLink) ok(`402 同时带 amtPaymentLink（${amtLink.slice(0, 24)}…）——官方预下单形态已通`);
    else warn('402 未带 amtPaymentLink——官方支付能力的买方少一条路（预下单可能失败，已自动降级）');
  }
  const hz = await (await fetch(`${BASE}/healthz`, { signal: AbortSignal.timeout(15000) })).json();
  hz.env === 'production' ? ok('线上 env=production') : bad(`线上 env=${hz.env}（期望 production）`);
} catch (err) {
  bad(`线上复验失败：${err.message}`);
}

console.log(`\n${failed ? R : G}${failed ? `生产切换未完成：${failed} 项未通过` : '生产切换完成'}${N}`);
if (!failed) {
  console.log(`\n下一步：让一位真人（可含你自己）在 ${BASE} 走一次真实付款；`);
  console.log('然后跑 node scripts/first-trade-no.mjs 取 28 位交易号，填进 提交材料/作品提交就绪包.md。');
}
process.exit(failed ? 1 : 0);
