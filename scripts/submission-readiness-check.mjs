#!/usr/bin/env node
/**
 * 提交就绪闸门（submission-readiness-check）
 *
 * 为什么这是**提交前最后一道关**：提交表单是整个比赛唯一不可逆的产物——
 * 填错一个价格、死一个链接、超一个字数，评委看到的就是"不严谨"，而没有第二次机会。
 * 本脚本把**机械可查**的项全部自动核对，任何一项不过就不该点提交。
 *
 * 检查项：
 *   ① 表单字段：必填项齐全、字数在官方上限内（标题 ≤20、简介 1–200、详情 ≤2000）
 *   ② **价格一致性**：提交文案里出现的每个档位价格，必须与 config/services.json 的
 *      生产价**逐一相符**（写错价格是评委最容易当场抓到、也最致命的破绽）
 *   ③ 演示地址：https 可达 + 能产出官方工具可吃的 402 账单 + 账户中心可用
 *   ④ 仓库链接：公开可访问
 *   ⑤ 提交实物：介绍 PDF 可读（页数 ≥1）、演示视频时长在合理区间（20–180s）、
 *      **评审附件 zip 内文件齐全且不比源文件旧**（打包时机错位是常见坑）
 *   ⑥ 收款方支付宝账号：与 PAYATHON 报名资料一致（账号一致性是官方硬性红线）
 *   ⑦ 场景/档位数量与站点实测一致（档位表 4 档、场景 3 个）
 *
 * 用法：node scripts/submission-readiness-check.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAT = path.join(ROOT, '提交材料');
const READY = path.join(MAT, '作品提交就绪包.md');
const BASE = (process.env.BASE_URL ?? 'https://121.43.80.231/sceneguide').replace(/\/$/, '');

const G = '\x1b[32m', R = '\x1b[31m', Y = '\x1b[33m', C = '\x1b[36m', N = '\x1b[0m';
let failed = 0, warned = 0;
const ok = (m) => console.log(`  ${G}✓${N} ${m}`);
const bad = (m) => { console.log(`  ${R}✗ ${m}${N}`); failed += 1; };
const warn = (m) => { console.log(`  ${Y}! ${m}${N}`); warned += 1; };
const step = (m) => console.log(`\n${C}▸ ${m}${N}`);


/**
 * 读 zip 的 central directory，拿到条目名 + 修改时间。
 * 不用 `unzip -Z1`：macOS 的 unzip 未置 UTF-8 flag，中文名会乱码，
 * 会让「附件是否齐全」「打包是否过期」这两项检查全部误判。
 */
function listZipEntries(buf) {
  const out = [];
  // 找 EOCD
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return out;
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const time = buf.readUInt16LE(off + 12);
    const date = buf.readUInt16LE(off + 14);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const name = buf.slice(off + 46, off + 46 + nameLen).toString('utf8');
    const y = 1980 + ((date >> 9) & 0x7f);
    const mo = (date >> 5) & 0x0f;
    const d = date & 0x1f;
    const hh = (time >> 11) & 0x1f;
    const mm = (time >> 5) & 0x3f;
    out.push({
      name,
      mtime: new Date(y, mo - 1, d, hh, mm),
    });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

// ── 表单字段提取 ──────────────────────────────────────────────
const readyText = fs.readFileSync(READY, 'utf8');
function block(label) {
  // 标题可能带补充说明（如「详情介绍（≤ 2000 字，实测 1651 字 ✅）」），因此允许标题后跟任意非换行文本
  const re = new RegExp(`### ${label}[^\\n]*\\n+\`\`\`\\n([\\s\\S]*?)\n\`\`\``);
  const m = readyText.match(re);
  return m ? m[1].trim() : null;
}
const title = block('作品标题');
const intro = block('作品简介');
const detail = block('详情介绍') ?? block('详细介绍');
const access = block('如何获取作品');

step('① 表单字段完整性与字数');
if (title) ok(`作品标题：${title}（${[...title].length} 字 / 上限 20）`);
else bad('作品标题缺失');
if (title && [...title].length > 20) bad(`标题超字数：${[...title].length} > 20`);
if (intro) ok(`作品简介：${[...intro].length} 字 / 上限 200`);
else bad('作品简介缺失');
if (intro && ([...intro].length < 1 || [...intro].length > 200)) bad(`简介字数越界：${[...intro].length}`);
if (detail) ok(`详细介绍：${[...detail].length} 字 / 上限 2000`);
else bad('详细介绍缺失');
if (detail && [...detail].length > 2000) bad(`详情超字数：${[...detail].length} > 2000`);
if (!access) bad('「如何获取作品」缺失');
else ok('「如何获取作品」已填');
// 交易号槽位：应保留占位并有明确说明
if (/待填/.test(readyText)) warn('AI 付接入凭证仍是「待填」——提交前必须贴入 28 位交易号');
else ok('AI 付接入凭证已填入交易号');

step('② 价格与档位一致性（对照 config/services.json）');
const svc = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'services.json'), 'utf8'));
const tiers = svc.tiers ?? {};
const priceMap = Object.fromEntries(Object.entries(tiers).map(([k, v]) => [k, String(v.unitPrice)]));
for (const [name, price] of Object.entries(priceMap)) {
  const inDetail = detail?.includes(price);
  inDetail
    ? ok(`档位 ${name} 的生产价 ¥${price} 在提交文案中一致`)
    : bad(`档位 ${name} 的生产价 ¥${price} 未出现在提交文案里——评委对照会不一致`);
}
// 文案里若出现了 ¥x.xx 形式的档位价，必须能在 services.json 里找到
const mentioned = new Set((`${detail ?? ''} ${intro ?? ''}`.match(/¥\d+\.\d{2}/g) ?? []));
const known = new Set(Object.values(priceMap).map((p) => `¥${p}`));
for (const m of mentioned) {
  known.has(m) || m === '¥0.01'
    ? ok(`文案中的 ${m} 有据可查`)
    : bad(`文案里出现了 ${m}，但不在服务档位价目表里（${[...known].join(' / ')}）`);
}

step('③ 演示地址可用性（评委点开的第一个链接）');
const demo = BASE;
try {
  const res = await fetch(`${demo}/api/v1/guide?scene=demo-park&query=%E6%B5%8B%E8%AF%95`, {
    redirect: 'manual', signal: AbortSignal.timeout(20000),
  });
  res.status === 402 ? ok('402 支付挑战可用') : bad(`未返回 402（${res.status}）`);
  res.headers.get('payment-needed') ? ok('Payment-Needed 头存在') : bad('缺 Payment-Needed 头');
} catch (e) { bad(`演示地址不可达：${e.message}`); }
for (const p of ['/', '/account.html', '/introduction.html', '/llms.txt']) {
  try {
    const r = await fetch(`${demo}${p}`, { signal: AbortSignal.timeout(12000) });
    r.ok ? ok(`GET ${p} → ${r.status}`) : bad(`GET ${p} → ${r.status}`);
  } catch (e) { bad(`GET ${p} 失败：${e.message}`); }
}

step('④ 仓库链接公开可访问');
const repoMatch = readyText.match(/https:\/\/github\.com\/[^\s`)]+/);
if (!repoMatch) bad('提交文案里没有仓库链接');
else {
  const url = repoMatch[0];
  try {
    const r = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(20000) });
    r.ok ? ok(`仓库可访问：${url}`) : bad(`仓库返回 ${r.status}：${url}`);
  } catch (e) { bad(`仓库不可达：${e.message}`); }
}

step('⑤ 提交实物');
const pdfPath = path.join(MAT, '作品介绍文档.pdf');
if (!fs.existsSync(pdfPath)) bad('缺少 作品介绍文档.pdf');
else {
  const pdf = fs.readFileSync(pdfPath);
  const pages = (pdf.toString('latin1').match(/\/Type \/Page[^s]/g) || []).length;
  pages >= 1 ? ok(`介绍 PDF 可读（${pages} 页，${(pdf.length / 1048576).toFixed(1)} MB）`) : bad('介绍 PDF 解析不出页数');
}
const vids = fs.readdirSync(MAT).filter((f) => f.endsWith('.mp4') && f.includes('2026'));
if (!vids.length) bad('缺少新版演示视频');
else {
  const v = vids.sort().pop();
  // ffprobe 的摘要写在 **stderr**，且以非 0 退出——必须合并两个流再解析
  let dur = 0;
  try {
    const { execSync } = await import('node:child_process');
    const out = execSync(`ffprobe -hide_banner -i ${JSON.stringify(path.join(MAT, v))} 2>&1 || true`, { encoding: 'utf8' });
    const m = out.match(/Duration: (\d+):(\d+):([\d.]+)/);
    if (m) dur = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  } catch {}
  (dur >= 20 && dur <= 180)
    ? ok(`演示视频 ${v} 时长 ${dur.toFixed(1)}s（在 20–180s 合理区间）`)
    : bad(`演示视频时长异常：${dur}s（${v}）`);
}
const zips = fs.readdirSync(MAT).filter((f) => f.endsWith('.zip') && f.includes('评审包'));
if (!zips.length) bad('缺少评审附件 zip');
else {
  const z = zips.sort().pop();
  const zPath = path.join(MAT, z);
  const zSize = fs.statSync(zPath).size;
  ok(`评审附件包：${z}（${(zSize / 1048576).toFixed(1)} MB）`);
  // 打包时机检查：zip 是否比它包含的源文件旧
  // 自己读 zip 的 central directory：unzip -Z1 在 macOS 下中文名会乱码（UTF-8 flag 未置）
  const entries = listZipEntries(fs.readFileSync(zPath));
  const need = ['作品介绍文档.pdf', '验收说明.txt', '说明.txt'];
  for (const n of need) {
    entries.some((e) => e.name.includes(n))
      ? ok(`附件包含 ${n}`)
      : bad(`附件缺少 ${n}`);
  }
  // 打包时机：包内每个条目都不应早于它的源文件（否则提交的是旧内容）
  const srcOf = (name) => path.join(MAT, name);
  let stale = 0;
  for (const e of entries) {
    const src = srcOf(e.name);
    if (!fs.existsSync(src)) continue;
    if (e.mtime.getTime() + 60000 < fs.statSync(src).mtime.getTime()) {
      bad(`附件包里的 ${e.name} 比源文件旧——需要重新打包`);
      stale += 1;
    }
  }
  if (stale === 0) ok('附件包内每个文件都不早于其源文件（打包时机正确）');
}

step('⑥ 收款方支付宝账号与报名资料一致');
const payee = (readyText.match(/收款方支付宝账号[：:\s]*([0-9]+)/) ?? [])[1];
if (!payee) bad('就绪包里找不到「收款方支付宝账号」');
else if (payee === '17835411002') ok(`收款方账号 ${payee} 与报名资料一致`);
else bad(`收款方账号 ${payee} 与报名资料 17835411002 不一致——账号一致性是官方红线`);

step('⑦ 站点实测的档位与场景数');
try {
  const meta = await (await fetch(`${demo}/api/v1/meta`, { signal: AbortSignal.timeout(12000) })).json();
  const siteTiers = (meta.tiers ?? []).length;
  siteTiers === Object.keys(priceMap).length
    ? ok(`站点档位数 ${siteTiers} 与配置一致`)
    : bad(`站点档位数 ${siteTiers} ≠ 配置 ${Object.keys(priceMap).length}`);
  const scenes = (meta.scenes ?? []).length;
  scenes >= 3 ? ok(`站点场景数 ${scenes}（≥3）`) : warn(`站点场景数 ${scenes}`);
} catch (e) { warn(`meta 读取失败：${e.message}`); }

console.log(`\n${failed ? R : G}${failed ? `有 ${failed} 项未通过——先别点提交` : '提交就绪检查全部通过'}${N}${warned ? `（${warned} 项提醒）` : ''}`);
process.exit(failed ? 1 : 0);
