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

step('②b 提交表单里不得残留占位符');
// 教训（2026-11-24）：「如何获取作品」里的仓库链接曾写成 https://github.com/<账号>/…
//   ——评委点开是 404，而闸门却因为**文里别处**有真实地址而判过。
//   所以这里改成**通用占位符扫描**：提交表单里任何 <…> 形式的待填标记都不允许。
{
  const formText = [title, intro, detail, access, readyText].filter(Boolean).join('\n');
  const placeholders = [...formText.matchAll(/<[^<>\n]{1,40}>/g)]
    .map((m) => m[0])
    .filter((t) => !/^<\/?[a-z][^<>]*>$/i.test(t))   // 排除 HTML 标签
    .filter((t) => !/^<[a-z0-9_ -]+>$/i.test(t));
  const uniq = [...new Set(placeholders)];
  uniq.length === 0
    ? ok('提交表单中无未替换的占位符')
    : bad(`提交表单里残留占位符（评委点开会出错）：${uniq.join(' / ')}`);
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
    // 超时放宽到 60s：这台机器到 github.com 实测要 40s+ 才拉完（HTTP 200），
    // 20s 会把「网络慢」误判成「链接坏」——那会让闸门在唯一该拦的地方拦错东西。
    const r = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(60000) });
    r.ok ? ok(`仓库可访问：${url}`) : bad(`仓库返回 ${r.status}：${url}`);
  } catch (e) {
    // 只拦「链接真的坏了」：拿到了 HTTP 响应但状态不对 → 拦。
    // 网络层失败（fetch failed / connection reset / 超时 / DNS）一律只提醒——
    // 这台机器到 github.com 实测要 40–75s，body 传输中途被重置（curl 退出码 56 但 http=200）。
    // 把它判成断链，会让闸门在唯一该拦的地方拦错东西。
    warn(`仓库链接本轮没验成（${e.message}）——网络层失败，不是断链；提交前请在浏览器里手动点开确认`);
  }
}

step('⑤ 提交实物');
const pdfPath = path.join(MAT, '作品介绍文档.pdf');
if (!fs.existsSync(pdfPath)) bad('缺少 作品介绍文档.pdf');
else {
  const pdf = fs.readFileSync(pdfPath);
  const pages = (pdf.toString('latin1').match(/\/Type \/Page[^s]/g) || []).length;
  pages >= 1 ? ok(`介绍 PDF 可读（${pages} 页，${(pdf.length / 1048576).toFixed(1)} MB）`) : bad('介绍 PDF 解析不出页数');
}
// 只认「演示视频-…-<日期>.mp4」形制的现行版；存档的旧版一律忽略
// （2026-11-27：目录里曾同时躺着三版视频，按文件名 sort().pop() 虽能挑对，
//  但提交时人手滑就会选错——旧版首屏数字与「真实付费」口径都是过时的。）
const vids = fs.readdirSync(MAT).filter((f) => /^演示视频-.*-\d{8}\.mp4$/.test(f));
if (!vids.length) bad('缺少现行版演示视频（命名应为 演示视频-…-YYYYMMDD.mp4）');
else {
  const v = vids.sort().pop();
  // 现行版必须比所有存档版都新，否则说明录完没归档
  const archives = fs.readdirSync(MAT).filter((f) => f.startsWith('存档-旧版-') && f.endsWith('.mp4'));
  const newestArchive = archives.sort().pop();
  if (newestArchive && v < newestArchive.replace(/^存档-旧版-/, '')) {
    warn(`现行版 ${v} 看起来不比存档版 ${newestArchive} 新——确认没录完忘归档`);
  }
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
  // 清单来自 config/review-package.json —— 与打包脚本共用同一份，不会漂移
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'review-package.json'), 'utf8'));
  for (const f of pkg.files) {
    entries.some((e) => e.name === f.name)
      ? ok(`附件包含 ${f.zh}（${f.name}）`)
      : bad(`附件缺少 ${f.zh}（${f.name}）`);
  }
  entries.some((e) => e.name === (pkg.readme ?? 'README.txt'))
    ? ok('附件包含包内说明 README（中文名 ↔ 英文名对照表）')
    : bad('附件缺少包内说明 README');
  // 包内条目名不得含非 ASCII 字符——否则就把编码风险又放回去了
  const nonAscii = entries.filter((e) => /[^\x20-\x7e]/.test(e.name)).map((e) => e.name);
  nonAscii.length === 0
    ? ok('附件包内所有文件名均为 ASCII（任何解压工具都不会乱码）')
    : bad(`附件包内有非 ASCII 文件名（可能被解码成乱码）：${nonAscii.join(' / ')}`);
  // 打包时机：包内每个条目都不应早于它的源文件（否则提交的是旧内容）
  // ⚠️ 必须按 config/review-package.json 的 name→src 映射回查：
  //   包内名是 ASCII（work-description.pdf），直接拿包内名去 MAT 里找源文件找不到，
  //   这条检查会被整体跳过——曾经就是这样静默失效的（形同虚设）。
  const srcOf = new Map((pkg.files ?? []).map((f) => [f.name, path.join(MAT, f.src)]));
  let stale = 0;
  let checked = 0;
  for (const e of entries) {
    const src = srcOf.get(e.name);
    if (!src || !fs.existsSync(src)) continue;
    checked += 1;
    if (e.mtime.getTime() + 60000 < fs.statSync(src).mtime.getTime()) {
      bad(`附件包里的 ${e.name} 比源文件旧——需要重新打包`);
      stale += 1;
    }
  }
  if (checked === 0) {
    bad('打包时机检查一条都没跑起来（包内名到源文件的映射对不上）');
  } else if (stale === 0) {
    ok(`附件包内 ${checked} 个文件都不早于其源文件（打包时机正确）`);
  }
}

step('⑤b 作品图标 / 封面图（表单上传位）');
/**
 * 读 PNG 头拿到真实像素尺寸。
 * 用真实尺寸判定，而不是信文件名——文件名叫「方形960」但实际不是方形，
 * 到了表单里会被裁掉一角，这是提交后才看得见的坑。
 */
function pngSize(buf) {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  if (buf.toString('latin1', 12, 16) !== 'IHDR') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}
const MAX_UPLOAD = 20 * 1024 * 1024; // 官方表单：作品图片 ≤20MB
const images = [
  { file: '作品图标-方形960.png', label: '作品图标', ratio: 1, minW: 900 },
  { file: '作品封面-16x9.png', label: '作品封面', ratio: 16 / 9, minW: 1600 },
];
for (const img of images) {
  const p = path.join(MAT, img.file);
  if (!fs.existsSync(p)) { bad(`缺少 ${img.label}：${img.file}`); continue; }
  const buf = fs.readFileSync(p);
  const size = pngSize(buf);
  if (!size) { bad(`${img.file} 不是有效 PNG（表头损坏）`); continue; }
  const bytes = buf.length;
  if (bytes > MAX_UPLOAD) { bad(`${img.file} 超过 ${MAX_UPLOAD / 1048576}MB 上限（${(bytes / 1048576).toFixed(1)}MB）`); continue; }
  const actual = size.width / size.height;
  if (Math.abs(actual - img.ratio) > 0.02) {
    bad(`${img.file} 比例 ${actual.toFixed(3)} 偏离目标 ${img.ratio.toFixed(3)}（${size.width}×${size.height}）`);
    continue;
  }
  if (size.width < img.minW) { bad(`${img.file} 宽度 ${size.width} < ${img.minW}（高清屏上会发虚）`); continue; }
  ok(`${img.label} ${img.file}：${size.width}×${size.height}，${(bytes / 1048576).toFixed(2)}MB，比例与体积均合规`);
}
// 封面主文件与轻量版不得内容相同（否则「上传时选错版本」会看不出来）
{
  const a = path.join(MAT, '作品封面-16x9.png');
  const b = path.join(MAT, '作品封面-16x9-1200.png');
  if (fs.existsSync(a) && fs.existsSync(b)) {
    fs.readFileSync(a).equals(fs.readFileSync(b))
      ? bad('封面主文件与 1200 轻量版内容相同——轻量版应是降采样的缩图')
      : ok('封面主文件与 1200 轻量版内容不同（轻量版确为降采样）');
  }
}

step('⑤c 分发文案是否已指向官方作品详情页（影响力 20% 的唯一落点）');
/**
 * 官方细则原文：「作品影响力 = 参赛作品详情页在支付宝 AI 付官网的浏览、点赞、评论等互动量综合评定」。
 * ⇒ 自己站的 PV 不算；**必须把读者引到官方作品详情页**，那一次浏览/点赞/评论才计分。
 * 官方作品页 URL 在提交并审核通过后才有，所以这里做的是「别忘了填」的提醒。
 */
{
  const p = path.join(MAT, '社区分发文案包.md');
  if (!fs.existsSync(p)) {
    warn('缺少 社区分发文案包.md——影响力 20% 没有分发素材就无从谈起');
  } else {
    const t = fs.readFileSync(p, 'utf8');
    const hasSlot = /官方作品详情页/.test(t);
    const unfilled = /【\s*官方作品详情页链接\s*】|【提交并审核通过后填入/.test(t);
    hasSlot
      ? (unfilled
          ? warn('分发文案里的官方作品详情页 URL 还是占位——提交并审核通过后填进去，否则影响力 20% 引不到落点')
          : ok('分发文案已填入官方作品详情页 URL'))
      : bad('分发文案里找不到官方作品详情页的入口——影响力 20% 统计的就是那个页面');
    // 每个帖子模板都应带这句 CTA，否则读者只会去看我们自己站
    // 官方榜单口径：评论数得分占 50%（浏览 20% / 点赞 30%），
    // 所以 CTA 必须**先要评论**。这里同时数「求评论」与「求点赞」两类，
    // 并单独确认「求评论」的出现次数不少于「求点赞」——否则等于把权重最高的丢了。
    // 只数**真正的 CTA 句式**，不数公式说明里提到的「点赞/评论」字样——
    // 第一版把说明文字也算进去，报出「求点赞 21 处 > 求评论 11 处」的假警报。
    const askComment = (t.match(/评论区报个地名|评论区直接报名字/g) ?? []).length;
    const askLike = (t.match(/点个赞也行|顺手点个赞/g) ?? []).length;
    askComment >= 3
      ? ok(`分发文案里有 ${askComment} 处「求评论」CTA、${askLike} 处「求点赞」——评论权重 50%，优先级正确`)
      : warn(`「求评论」CTA 只有 ${askComment} 处——官方口径下评论占 50%，每篇帖子都要有`);
    askLike > askComment
      ? warn(`「求点赞」CTA(${askLike}) 多于「求评论」CTA(${askComment})——评论才是 50% 权重，顺序反了`)
      : ok('CTA 权重顺序正确（评论优先于点赞）');
  }
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
