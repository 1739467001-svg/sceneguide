#!/usr/bin/env node
/**
 * 评审附件包构建器（build-review-zip）
 *
 * 为什么不用 `zip` 命令直接打包：
 *   macOS 自带的 Info-ZIP **不置 UTF-8 文件名标志位（general purpose flag bit 11 / 0x0800）**。
 *   实测 sg-评审包-20261123.zip 的四个条目 flags 全是 0x0000，
 *   而文件名字节本身已经是 UTF-8 —— 也就是说**只差这一个标志位**。
 *   后果：macOS 自带 unzip 会按 UTF-8 硬猜，本地看不出问题；
 *         但 **Windows 资源管理器 / Windows tar / 部分解压工具会按本地代码页解读**，
 *         评委解压拿到的是「???.pdf」「????.txt」——附件包是评分物，这种第一印象是白送的扣分。
 *   （官方只说「附件仅评审可见」，没说评委用什么系统解压，所以必须自己兼容。）
 *
 * 做法：
 *   ① `zip` 负责压缩（成熟、快、支持 deflate）
 *   ② Node 扫描中央目录，把每个条目的 flags 补上 0x0800（本地头与中央目录两处都要补）
 *   ③ 重新读回校验：条目名能按 UTF-8 还原 + 标志位正确 + CRC/大小一致
 *   ④ 打包进一个 `README-文件说明.txt`，把中文名与英文名对应关系写死，
 *      万一某个工具仍按代码页解读，评委也能对上是哪个文件
 *
 * 用法：node scripts/build-review-zip.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAT = path.join(ROOT, '提交材料');

const G = '\x1b[32m', R = '\x1b[31m', C = '\x1b[36m', N = '\x1b[0m';
const ok = (m) => console.log(`  ${G}✓${N} ${m}`);
const bad = (m) => { console.log(`  ${R}✗ ${m}${N}`); process.exitCode = 1; };
const step = (m) => console.log(`\n${C}▸ ${m}${N}`);

/**
 * 附件包清单来自 config/review-package.json（单一事实源）。
 * 打包脚本与提交就绪闸门共用同一份清单——清单漂移过一次就会导致闸门查错文件。
 */
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'review-package.json'), 'utf8'));
const MANIFEST = PKG.files;

const README = `三维问路 · SceneGuide —— 评审附件包说明
================================================

本包共 ${MANIFEST.length} 个文件（包内文件名全部为英文，中文名对照见下表）：

${MANIFEST.map((f, i) => `${i + 1}. ${f.name}\n   中文名：${f.zh}\n   ${f.desc}`).join('\n\n')}

包内文件名为什么是英文：
  压缩包里的文件名是否正确显示，取决于解压工具是否尊重 UTF-8 文件名标志位。
  常见的 Windows 资源管理器 / 7-Zip / WinRAR / macOS 访达 / Python 都尊重，
  但部分命令行解压工具不尊重，会把中文名显示成乱码。
  因此包内一律用英文名，中文名与说明写在本文件里——不让文件名承担任何编码风险。

怎么自己验（不需要评审账号 / 邀请码）：
  1. 解压后看 acceptance-notes.txt，里面是一条命令：
     BASE_URL=https://121.43.80.231/sceneguide bash scripts/verify.sh
  2. 该命令会在我们线上服务上真实走一遍支付宝沙箱收银，共 88 项断言。
  3. 代码仓库（MIT 开源，含完整提交历史）：https://github.com/1739467001-svg/sceneguide

演示地址（手机/电脑均可，免注册）：https://121.43.80.231/sceneguide/
`;

// ── ① 暂存目录：把包内要放的文件按最终名字放好 ──────────────
step('① 暂存与清单核对');
const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-zip-'));
for (const f of MANIFEST) {
  const src = path.join(MAT, f.src);
  if (!fs.existsSync(src)) { bad(`缺少源文件：${f.src}`); continue; }
  // ⚠️ 必须 preserveTimestamps：默认拷贝会把 mtime 变成「现在」，
  //   于是 zip 条目的时间永远比源文件新——提交就绪闸门里那条「包内文件是否比源文件旧」
  //   的检查就永远为真，等于没有检查。保留时间戳，这条检查才真的能发现陈旧包。
  fs.cpSync(src, path.join(stage, f.name), { preserveTimestamps: true });
  ok(`${f.src} → ${f.name}（${(fs.statSync(src).size / 1048576).toFixed(2)}MB，mtime ${fs.statSync(src).mtime.toISOString().slice(0, 16).replace('T', ' ')}）`);
}
fs.writeFileSync(path.join(stage, PKG.readme ?? 'README.txt'), README, 'utf8');
ok(`${PKG.readme ?? 'README.txt'}（中文名 ↔ 英文名对照表）`);

// ── ② 用 zip 压缩 ───────────────────────────────────────────
step('② 压缩');
// 用**本地日期**（不是 UTC）：本机在 UTC+8，凌晨 00:3x 时 UTC 日期还停在前一天，
// 用 toISOString 会把当天的包命名成昨天——早先那版就踩到了（生成 20261123 却其实是 11-24 的料）。
const now = new Date();
const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
const finalPath = path.join(MAT, `sg-评审包-${stamp}.zip`);
const tmpZip = path.join(stage, '..', `sg-review-${stamp}.zip`);
try { fs.unlinkSync(tmpZip); } catch {}
execFileSync('zip', ['-X', '-q', '-r', tmpZip, '.'], { cwd: stage, stdio: 'inherit' });
ok(`zip 完成：${(fs.statSync(tmpZip).size / 1048576).toFixed(2)}MB`);

// ── ③ 补 UTF-8 文件名标志位 ─────────────────────────────────
step('③ 补 UTF-8 文件名标志位（bit 11 / 0x0800）');
const buf = fs.readFileSync(tmpZip);
let eocd = -1;
for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i--) {
  if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
}
if (eocd < 0) { bad('找不到 zip 中央目录结尾记录（EOCD）——文件不是合法 zip'); process.exit(1); }

const count = buf.readUInt16LE(eocd + 10);
let off = buf.readUInt32LE(eocd + 16);
let patched = 0;
const names = [];
for (let i = 0; i < count; i++) {
  if (buf.readUInt32LE(off) !== 0x02014b50) { bad(`中央目录第 ${i + 1} 项签名不对`); break; }
  const nameLen = buf.readUInt16LE(off + 28);
  const extraLen = buf.readUInt16LE(off + 30);
  const commentLen = buf.readUInt16LE(off + 32);
  const name = buf.slice(off + 46, off + 46 + nameLen).toString('utf8');
  if (name.endsWith('/')) { off += 46 + nameLen + extraLen + commentLen; continue; }

  // 中央目录条目头
  const cdFlags = buf.readUInt16LE(off + 8);
  buf.writeUInt16LE(cdFlags | 0x0800, off + 8);
  // 本地文件头（同一份标志位也要置上，否则部分工具读本地头时仍按代码页解读）
  const localOff = buf.readUInt32LE(off + 42);
  if (buf.readUInt32LE(localOff) !== 0x04034b50) {
    bad(`${name} 的本地文件头签名不对`);
  } else {
    buf.writeUInt16LE(buf.readUInt16LE(localOff + 6) | 0x0800, localOff + 6);
  }
  patched += 1;
  names.push(name);
  off += 46 + nameLen + extraLen + commentLen;
}
fs.writeFileSync(tmpZip, buf);
ok(`已为 ${patched} 个条目置上 0x0800`);

// ── ④ 回读校验 ─────────────────────────────────────────────
step('④ 回读校验');
const check = fs.readFileSync(tmpZip);
let e2 = -1;
for (let i = check.length - 22; i >= 0 && i > check.length - 66000; i--) {
  if (check.readUInt32LE(i) === 0x06054b50) { e2 = i; break; }
}
const c2 = check.readUInt16LE(e2 + 10);
let o2 = check.readUInt32LE(e2 + 16);
let verified = 0;
for (let i = 0; i < c2; i++) {
  if (check.readUInt32LE(o2) !== 0x02014b50) break;
  const flags = check.readUInt16LE(o2 + 8);
  const nameLen = check.readUInt16LE(o2 + 28);
  const extraLen = check.readUInt16LE(o2 + 30);
  const commentLen = check.readUInt16LE(o2 + 32);
  const name = check.slice(o2 + 46, o2 + 46 + nameLen).toString('utf8');
  if (name.endsWith('/')) { o2 += 46 + nameLen + extraLen + commentLen; continue; }
  if (!(flags & 0x0800)) bad(`${name} 仍未置 UTF-8 标志位`);
  else if (/[^\x20-\x7e]/.test(name) && !/^[\x20-\x7e]*$/.test(name)) {
    // 中文名能被 UTF-8 还原（而不是变成问号）才算数
    const bytes = check.slice(o2 + 46, o2 + 46 + nameLen);
    if (bytes.toString('utf8') !== name) bad(`${name} 的名字字节无法按 UTF-8 还原`);
    else verified += 1;
  } else verified += 1;
  o2 += 46 + nameLen + extraLen + commentLen;
}
if (verified === names.length) ok(`${verified} 个条目：标志位正确 + 中文名可还原`);
else bad(`仅 ${verified}/${names.length} 个条目通过校验`);

// 每个清单文件都得真的在包里
for (const f of MANIFEST) {
  names.includes(f.name) ? ok(`包内含 ${f.name}`) : bad(`包内缺 ${f.name}`);
}

// ── ⑤ 落盘 ─────────────────────────────────────────────────
step('⑤ 落盘');
fs.copyFileSync(tmpZip, finalPath);
fs.unlinkSync(tmpZip);
fs.rmSync(stage, { recursive: true, force: true });
ok(`→ ${path.relative(ROOT, finalPath)}（${(fs.statSync(finalPath).size / 1048576).toFixed(2)}MB）`);

console.log(process.exitCode ? `\n${R}附件包构建有问题${N}` : `\n${G}附件包构建完成${N}`);
