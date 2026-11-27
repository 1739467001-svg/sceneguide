#!/usr/bin/env node
/**
 * 数字诚信自检（verify-honest-numbers）
 *
 * 为什么单独一项（2026-11-27 实测发现的问题）：
 *   站点首屏与看板向评委展示「真实付费用户数」。这个数字的可信度就是本作品的
 *   可信度——官方规则明写「违规、虚假交易及刷量数据会取消评选资格」。
 *
 *   实测发现的漏洞：`paidReal` 曾是 33，逐笔查下来**100% 是我们自己的验收脚本**
 *   （judge-flow.mjs 与 official-buyer-check.sh 打的都是公开 402 端点，
 *    且不带任何身份，于是每一跑都是一个查不出来源的新访客）。
 *   即：我们用自己的自动化测试把展示给评委的数字抬高了 33。
 *   而仓储层原本就有 `SELF_TEST_SQL` 前缀排除——只是这两个脚本绕过了它。
 *
 * 已修（见 src/orders/repository.js）：
 *   ① judge-flow 带 `sg_vid=judge-cold-<ts>`（仍是冷访客，只是身份可识别）
 *   ② official-buyer-check 的 URL 带 `ref=selfcheck`（官方脚本不接受自定义头）
 *   ③ 沙箱交易号（32 位）不计真实付款——同时回溯修正了历史那 33 笔
 *
 * 本项做三件事：
 *   ① 三个展示位数字必须自洽（stats / growth 漏斗 / 站点首屏）
 *   ② **跑一遍我们自己的官方买方验收，断言 paidReal 不上升**（这是真正的回归防线）
 *   ③ 站点展示的数字必须等于 API 返回的数字（不能有硬编码/过期展示）
 *
 * 用法：node scripts/verify-honest-numbers.mjs
 *       BASE_URL=https://121.43.80.231/sceneguide node scripts/verify-honest-numbers.mjs
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = (process.env.BASE_URL ?? 'https://121.43.80.231/sceneguide').replace(/\/$/, '');

const G = '\x1b[32m', R = '\x1b[31m', Y = '\x1b[33m', C = '\x1b[36m', N = '\x1b[0m';
let failed = 0;
const ok = (m) => console.log(`  ${G}✓${N} ${m}`);
const bad = (m) => { console.log(`  ${R}✗ ${m}${N}`); failed += 1; };
const warn = (m) => console.log(`  ${Y}!${N} ${m}`);
const step = (m) => console.log(`\n${C}▸ ${m}${N}`);

const j = async (url, opts = {}) => {
  const r = await fetch(`${BASE}${url}`, { signal: AbortSignal.timeout(25000), ...opts });
  return r.json().catch(() => ({}));
};

// ── ① 三个展示位自洽 ────────────────────────────────────────
step('① 三个展示位数字自洽');
const stats = await j('/api/v1/stats');
const growth = await j('/api/v1/growth').catch(() => ({}));
const sReal = Number(stats.paidReal ?? -1);
const sPaid = Number(stats.paid ?? -1);
console.log(`      stats：paid=${sPaid}  paidReal=${sReal}`);

if (sReal < 0) bad('stats 未返回 paidReal');
else if (sReal > sPaid) bad(`paidReal(${sReal}) > paid(${sPaid})——逻辑不可能`);
else ok(`paidReal ≤ paid（${sReal} ≤ ${sPaid}）`);

// growth 漏斗里的「其中真实」必须与 stats 同口径
const gReal = Number(growth?.funnel?.paidReal ?? growth?.paidReal ?? NaN);
Number.isFinite(gReal)
  ? (gReal === sReal ? ok(`growth 漏斗「其中真实」=${gReal}，与 stats 一致`) : bad(`growth=${gReal} 与 stats=${sReal} 不一致——三个并列数字必须自洽`))
  : warn('growth 未暴露可比对的 paidReal 字段（跳过同口径比对）');

// ── ② 站点展示值 = API 值 ───────────────────────────────────
step('② 站点首屏展示值 = API 返回值');
{
  const html = await fetch(`${BASE}/`, { signal: AbortSignal.timeout(25000) }).then((r) => r.text());
  // 首屏统计由 JS 从 /api/v1/stats 拉取后渲染，这里确认页面**没有**硬编码一个真实付费数
  const hardcoded = html.match(/真实付费[^<]{0,20}?(\d{2,})/);
  hardcoded
    ? warn(`首屏 HTML 里出现硬编码的「真实付费 ${hardcoded[1]}」——确认它不是过期快照`)
    : ok('首屏无硬编码的真实付费数（由 API 实时渲染）');
}

// ── ③ 跑我们自己的官方买方验收，paidReal 不得上升 ───────────
step('③ 自己的验收不得抬高 paidReal（真正的回归防线）');
{
  const before = Number((await j('/api/v1/stats')).paidReal ?? -1);
  let out = '';
  try {
    out = execFileSync('bash', [path.join(ROOT, 'scripts', 'official-buyer-check.sh')], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, BASE_URL: BASE },
    });
  } catch (err) {
    out = `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }
  const passed = /联调通过/.test(out);
  passed ? ok('官方买方验收本身通过（服务仍被官方脚本买通）') : warn('官方买方验收未通过——不影响本项结论，但要单独排查');

  const after = Number((await j('/api/v1/stats')).paidReal ?? -1);
  if (before < 0 || after < 0) {
    warn('没能读到验收前后的 paidReal，跳过比对');
  } else if (after > before) {
    bad(`跑一遍自己的验收，paidReal 从 ${before} 涨到 ${after}——自测订单又漏进「真实付费」了`);
  } else {
    ok(`跑一遍自己的验收，paidReal 保持 ${before}（自测订单被正确排除）`);
  }
}

console.log(`\n${failed ? R : G}${failed ? `失败 ${failed} 项——数字诚信有问题，先别提交` : '数字诚信自检全部通过'}${N}`);
process.exit(failed ? 1 : 0);
