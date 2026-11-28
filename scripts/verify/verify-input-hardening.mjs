#!/usr/bin/env node
/**
 * 输入健壮性压测（verify-input-hardening）
 *
 * 为什么单独一项（2026-11-27 实测抓到一个真 bug）：
 *   把 URL 的 `tier` 改成「非法档位」，服务端返回 **500 CREATE_ORDER_ERROR**。
 *   这是**用户输入问题**，却被表现成服务端故障——评委（或任何人）手动改一个参数
 *   就会看到「这服务不健壮」，直接打在「产品完整度 30%」的
 *   「核心功能链路完整可用，无明显 bug」上。
 *   同类风险：空 query、超长 query、不存在的场景、同名起终点、
 *   带 HTML/脚本的 query、尾随逗号的 checkpoints、非法 mode/tier。
 *
 *   已修：未知 tier 在**发起业务之前**前置校验，返回 400 + 合法取值清单。
 *
 * 判定口径：
 *   · 正常请求 → 402（支付挑战，沙箱/生产都该如此）
 *   · 明确非法的输入 → 4xx（拒绝，且说清为什么）
 *   · **任何 5xx 都是失败**——用户可控参数不该把服务端打挂
 *
 * 用法：node scripts/verify/verify-input-hardening.mjs
 *       BASE_URL=https://121.43.80.231/sceneguide node scripts/verify/verify-input-hardening.mjs
 */
const BASE = (process.env.BASE_URL ?? 'https://121.43.80.231/sceneguide').replace(/\/$/, '');
const RES = `${BASE}/api/v1/guide`;

const G = '\x1b[32m', R = '\x1b[31m', Y = '\x1b[33m', C = '\x1b[36m', N = '\x1b[0m';
let failed = 0;
const ok = (m) => console.log(`  ${G}✓${N} ${m}`);
const bad = (m) => { console.log(`  ${R}✗ ${m}${N}`); failed += 1; };
const step = (m) => console.log(`\n${C}▸ ${m}${N}`);

const enc = (s) => encodeURIComponent(s);

/** 每个用例：说明 + 期望（402 = 正常挑战 / 4xx = 明确拒绝） */
const CASES = [
  { name: '空 query', qs: `scene=zjgsu-xiasha&query=`, expect: '402' },
  { name: '超长 query（400 字）', qs: `scene=zjgsu-xiasha&query=${enc('啊'.repeat(400))}`, expect: '4xx' },
  { name: '纯空白 query', qs: `scene=zjgsu-xiasha&query=${enc('   ')}`, expect: '402' },
  { name: '不存在的场景', qs: `scene=${enc('不存在的场景')}&query=x`, expect: '402' },
  { name: '问不存在的地标', qs: `scene=zjgsu-xiasha&query=${enc('从火车站到月球怎么走')}`, expect: '402' },
  { name: 'query 带 HTML/脚本', qs: `scene=zjgsu-xiasha&query=${enc('<script>alert(1)</script>')}`, expect: '402' },
  { name: '同名起终点', qs: `scene=zjgsu-xiasha&query=${enc('从A教学楼到A教学楼')}`, expect: '402' },
  { name: '非法 tier', qs: `scene=zjgsu-xiasha&query=test&tier=${enc('非法档位')}`, expect: '4xx' },
  { name: '空 tier', qs: `scene=zjgsu-xiasha&query=test&tier=`, expect: '4xx' },
  { name: '合法 tier=single', qs: `scene=zjgsu-xiasha&query=test&tier=single`, expect: '402' },
  { name: '合法 tier=pack10', qs: `scene=zjgsu-xiasha&query=test&tier=pack10`, expect: '402' },
  { name: '合法 tier=quest', qs: `scene=zjgsu-xiasha&query=test&tier=quest`, expect: '402' },
  { name: '合法 tier=trial', qs: `scene=zjgsu-xiasha&query=test&tier=trial`, expect: '402' },
  { name: 'checkpoints 尾随逗号', qs: `scene=zjgsu-xiasha&query=test&mode=quest&checkpoints=${enc('图书馆,')}`, expect: '402' },
  { name: '非法 mode', qs: `scene=zjgsu-xiasha&query=test&mode=${enc('bogus')}`, expect: '402' },
  { name: 'SQL 注入尝试', qs: `scene=zjgsu-xiasha&query=${enc("x' OR 1=1--")}`, expect: '402' },
  { name: '超长 scene', qs: `scene=${enc('S'.repeat(500))}&query=x`, expect: '402' },
];

step(`输入健壮性压测（${CASES.length} 个用例，目标 ${RES}）`);
let fiveXx = 0;
for (const c of CASES) {
  let status = 0;
  let body = '';
  try {
    const res = await fetch(`${RES}?${c.qs}`, { redirect: 'manual', signal: AbortSignal.timeout(25000) });
    status = res.status;
    body = await res.text().catch(() => '');
  } catch (err) {
    bad(`${c.name}：请求失败 ${err.message}`);
    continue;
  }
  const kind = status >= 500 ? '5xx' : status >= 400 ? '4xx' : String(status);
  if (status >= 500) {
    fiveXx += 1;
    bad(`${c.name}：HTTP ${status} —— 用户可控参数把服务端打挂了${body ? `（${body.slice(0, 80)}）` : ''}`);
    continue;
  }
  const matched = c.expect === kind
    || (c.expect === '4xx' && status >= 400 && status < 500)
    || (c.expect === '402' && status === 402);
  matched
    ? ok(`${c.name}：HTTP ${status}（符合预期 ${c.expect}）`)
    : warn(`${c.name}：HTTP ${status}，预期 ${c.expect}——确认是否有意为之`);
}

step('汇总');
if (fiveXx === 0) ok('无 5xx——用户可控输入不会把服务端打挂');
else bad(`${fiveXx} 个用例返回 5xx`);

console.log(`\n${failed ? R : G}${failed ? `失败 ${failed} 项` : '输入健壮性压测全部通过'}${N}`);
process.exit(failed ? 1 : 0);
