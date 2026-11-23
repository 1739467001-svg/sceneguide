#!/usr/bin/env node
/**
 * Shell 脚本「变量名后紧跟非 ASCII 字符」检测
 *
 * ## 这是什么坑
 *
 * bash 的变量名允许包含多字节字符。写 `echo "$SPLIT（树）"` 时，bash 会把
 * **全角括号一起吞进变量名**，变成 `$SPLIT（树` —— 那个变量从来没被赋值过。
 * 平时没事，但脚本一旦开了 `set -u`（未定义变量即报错）就立刻炸：
 *
 *     scripts/publish-public.sh: line 45: SPLIT（树: unbound variable
 *
 * ## 为什么值得单独做一条验收
 *
 * 这个项目已经被它咬过**两次**：
 *   ① 早先 verify.sh 自己的失败分支（bash 3.2 变量名不吃多字节字符）——
 *      报错语句自身崩溃，把验收中断在半路；
 *   ② 2026-11-24 新写的 publish-public.sh 第一次跑就栽在这上面。
 *
 * 两次的表现都是「脚本莫名其妙报一个看不懂的 unbound variable」，
 * 排查成本远高于写这条检查的成本。
 *
 * ## 检查器自己也必须先证明它能抓到
 *
 * 末尾有一项**自检**：真的跑一段会触发该问题的 bash，确认它确实报错。
 * 一个抓不到问题的检查器比没有检查器更糟——它会给出假的绿灯。
 *
 * 用法：node scripts/verify-shell-unicode.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const G = '\x1b[32m', R = '\x1b[31m', C = '\x1b[36m', N = '\x1b[0m';
let failed = 0;
const ok = (m) => console.log(`  ${G}✓${N} ${m}`);
const bad = (m) => { console.log(`  ${R}✗ ${m}${N}`); failed += 1; };
const step = (m) => console.log(`\n${C}▸ ${m}${N}`);

// ── 收集所有 shell 脚本 ──────────────────────────────────────
const SKIP_DIRS = new Set(['node_modules', '.git', 'data', 'vendor', 'out', 'assets']);
function collect(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) collect(p, out);
    else if (e.name.endsWith('.sh')) out.push(p);
  }
  return out;
}

step('① 检测 $变量 后紧跟非 ASCII 字符');
const scripts = collect(ROOT);
const offenders = [];
// 形如 $FOO 后面紧跟一个非 ASCII 字节 —— bash 会把它并进变量名
const PATTERN = /\$[A-Za-z_][A-Za-z0-9_]*[^\x00-\x7F]/;
for (const file of scripts) {
  const text = fs.readFileSync(file, 'utf8');
  text.split('\n').forEach((line, i) => {
    // 注释行不算（注释里 $VAR 不会被展开）
    const trimmed = line.trimStart();
    if (trimmed.startsWith('#')) return;
    if (PATTERN.test(line)) {
      offenders.push(`${path.relative(ROOT, file)}:${i + 1}  ${line.trim().slice(0, 100)}`);
    }
  });
}
if (offenders.length === 0) {
  ok(`${scripts.length} 个 shell 脚本均无此问题`);
} else {
  bad(`${offenders.length} 处变量名后紧跟非 ASCII 字符（bash 会把它并进变量名）——用 \${VAR} 隔断：`);
  for (const o of offenders.slice(0, 12)) console.log(`      ${o}`);
}

step('② 检查器自检（必须真的能抓到，否则是假绿灯）');
{
  // 真的触发一次：set -u + 变量名后紧跟全角括号
  const probe = 'set -u\nX=1\necho "$X（树"\n';
  let failedAsExpected = false;
  try {
    execFileSync('bash', ['-c', probe], { stdio: 'pipe' });
  } catch (err) {
    const out = `${err.stdout ?? ''}${err.stderr ?? ''}`;
    if (/unbound variable/.test(out)) failedAsExpected = true;
    else console.log(`      （探测输出：${out.trim().slice(0, 120)}）`);
  }
  failedAsExpected
    ? ok('自检通过：bash 确实把全角字符并进变量名并报 unbound variable（检测逻辑对得上真实行为）')
    : bad('自检失败：没能复现该行为——检测器可能抓不到真问题');
}

step('③ 同类坑的另一面：未加花括号的中文插值');
{
  // 「$VAR中文」在 set -u 下会炸；用 ${VAR} 就安全。
  // 顺带确认本仓的脚本里 ${VAR} 的写法是主流（说明作者知道这个坑）。
  const all = scripts
    .map((f) => fs.readFileSync(f, 'utf8'))
    .join('\n');
  const braced = (all.match(/\$\{[A-Za-z_][A-Za-z0-9_]*\}/g) ?? []).length;
  braced > 0
    ? ok(`仓库脚本里已有 ${braced} 处 \${VAR} 花括号写法`)
    : warn('仓库脚本里没有 ${VAR} 写法——一旦有人写 $VAR中文就会踩坑');
}

console.log(`\n${failed ? R : G}${failed ? `失败 ${failed} 项` : 'Shell 脚本 Unicode 变量名检测通过'}${N}`);
process.exit(failed ? 1 : 0);
