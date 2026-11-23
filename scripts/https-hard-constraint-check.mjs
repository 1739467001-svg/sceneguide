#!/usr/bin/env node
/**
 * 「付费资源必须 HTTPS」硬约束自检（https-hard-constraint-check）
 *
 * 为什么这是**致命级**约束（2026-11-23 实测发现）：
 *   官方买方 CLI 在对某个付费资源发起支付时，会先校验资源 URL：
 *       $ alipay-bot 402-buyer-pay --file 402_needed.txt --resource-url 'http://…'
 *       Error: paid resource URL must use HTTPS
 *   ⇒ **若提交给评委的演示地址是 http://，评委用支付宝官方工具买我们的服务会直接失败**，
 *     表现为「作品看起来能演示，但用官方工具一买就报错」——这会同时打穿
 *     「支付集成度 25%」与「商业化成熟度 25%」两个维度。
 *
 * 本项做两件事：
 *   ① 线上实测：https 入口能取到可解码的 402 账单（官方工具能吃下的形态）
 *   ② 静态审计：提交物料里**作为演示/资源地址**出现的必须是 https，
 *      不允许出现裸 http 的 IP 地址（文档里作为"降级说明"提及的除外）
 *
 * 用法：
 *   BASE_URL=https://121.43.80.231/sceneguide node scripts/https-hard-constraint-check.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = (process.env.BASE_URL ?? 'https://121.43.80.231/sceneguide').replace(/\/$/, '');

const G = '\x1b[32m', R = '\x1b[31m', C = '\x1b[36m', N = '\x1b[0m';
let failed = 0;
const ok = (m) => console.log(`  ${G}✓${N} ${m}`);
const bad = (m) => { console.log(`  ${R}✗ ${m}${N}`); failed += 1; };
const step = (m) => console.log(`\n${C}▸ ${m}${N}`);

step('① 线上 https 入口能产出官方工具可吃的 402 账单');
if (!BASE.startsWith('https://')) {
  bad(`BASE_URL 不是 https：${BASE}`);
} else {
  ok(`目标为 https：${BASE}`);
  try {
    const res = await fetch(
      `${BASE}/api/v1/guide?scene=zjgsu-xiasha&query=%E6%B5%8B%E8%AF%95`,
      { redirect: 'manual', signal: AbortSignal.timeout(20000) },
    );
    if (res.status !== 402) bad(`未返回 402（实际 ${res.status}）`);
    else ok('402 状态正确');
    const needed = res.headers.get('payment-needed');
    if (!needed) bad('缺少 Payment-Needed 头');
    else {
      ok('Payment-Needed 头存在');
      const decoded = JSON.parse(Buffer.from(needed, 'base64url').toString('utf8'));
      const need = ['protocol.out_trade_no', 'protocol.amount', 'protocol.currency',
        'protocol.resource_id', 'protocol.pay_before', 'protocol.seller_signature',
        'protocol.seller_sign_type', 'protocol.seller_unique_id',
        'method.seller_name', 'method.seller_id', 'method.seller_app_id',
        'method.goods_name', 'method.seller_unique_id_key', 'method.service_id'];
      const missing = need.filter((path) => {
        const [a, b] = path.split('.');
        return decoded?.[a]?.[b] === undefined || decoded?.[a]?.[b] === '';
      });
      missing.length === 0
        ? ok(`账单 14 个官方必需字段齐全（${need.length} 项）`)
        : bad(`账单缺字段：${missing.join(', ')}`);
    }
  } catch (err) {
    bad(`https 入口不可达：${err.message}`);
  }
}

step('② 提交物料的演示/资源地址必须为 https');
// 允许作为"降级说明"出现的 http（明确写了 HTTP 入口/降级/备用）
const ALLOW_HTTP = /(HTTP 入口|降级|备用|仍可用|不可用|非安全上下文|不满足)/;
// 只扫**本作品自己的**物料：scene-guide/ 全量 + 项目根的三份文档。
// （早期版本扫到了 ../../ 即整个 CJY项目，把别的项目的 http 地址也算进来了 —— 不相干）
const scanDirs = [
  '.',                            // scene-guide/ 自身（含 提交材料/ public/ deploy/）
  path.join('..', 'README.md'),
  path.join('..', '执行清单.md'),
  path.join('..', 'PAYATHON-2026-比赛信息.md'),
  path.join('..', '状态分析与下一步.md'),
];
const textExt = new Set(['.md', '.html', '.txt', '.json', '.js']);
const suspects = [];
for (const dir of scanDirs) {
  const abs = path.isAbsolute(dir) ? dir : path.join(ROOT, dir);
  if (!fs.existsSync(abs)) continue;
  const stack = [abs];
  while (stack.length) {
    const cur = stack.pop();
    let st;
    try { st = fs.statSync(cur); } catch { continue; }
    if (st.isDirectory()) {
      if (['node_modules', '.git', 'data', 'vendor'].includes(path.basename(cur))) continue;
      for (const e of fs.readdirSync(cur)) stack.push(path.join(cur, e));
      continue;
    }
    if (!textExt.has(path.extname(cur))) continue;
    let content;
    try { content = fs.readFileSync(cur, 'utf8'); } catch { continue; }
    const lines = content.split('\n');
    lines.forEach((line, i) => {
      if (!/http:\/\/121\.43\.80\.231\/sceneguide/.test(line)) return;
      // 上下文窗口：上一行 + 本行（降级说明常常写在上一行的引导句里）
      const ctx = `${lines[i - 1] ?? ''} ${line}`;
      if (ALLOW_HTTP.test(ctx)) return;
      suspects.push(`${path.relative(abs, cur) || path.basename(cur)}:${i + 1}  ${line.trim().slice(0, 110)}`);
    });
  }
}
if (suspects.length === 0) {
  ok('未发现裸 http 的 IP 演示地址（降级说明中的除外）');
} else {
  bad(`以下位置仍以 http 暴露演示地址（评委用官方工具买会失败）：`);
  for (const s of suspects.slice(0, 12)) console.log(`      ${s}`);
  if (suspects.length > 12) console.log(`      …共 ${suspects.length} 处`);
}

console.log(`\n${failed ? R : G}${failed ? `失败 ${failed} 项` : 'HTTPS 硬约束自检全部通过'}${N}`);
process.exit(failed ? 1 : 0);
