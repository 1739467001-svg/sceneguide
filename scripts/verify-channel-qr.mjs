#!/usr/bin/env node
/**
 * 渠道二维码指向校验（verify-channel-qr）
 *
 * 为什么值得单独一项：
 *   分发用的 7 张二维码是 11-18 生成的。如果那之后演示地址变过，
 *   二维码会指向一个打不开的地址——而二维码**没法用眼睛看出编码内容**，
 *   发到群里之前谁也不会发现，等到有人反馈"扫不开"已经晚了。
 *   （本项目就踩过地址变更的坑：演示地址从 http:// 裸 IP 迁到 https:// 真证书那一次。）
 *
 * 做法：重新生成一份到临时目录，与提交的二维码做**字节级比对**。
 *   PNG 编码是确定性的，字节一致 ⟺ 编码内容一致。
 *   这比"解码二维码"更稳——解码要额外依赖，而字节比对不需要。
 *
 * 用法：node scripts/verify-channel-qr.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = (process.env.BASE_URL ?? 'https://121.43.80.231/sceneguide').replace(/\/$/, '');
const QR_DIR = path.join(ROOT, '提交材料', '渠道二维码');

const G = '\x1b[32m', R = '\x1b[31m', C = '\x1b[36m', N = '\x1b[0m';
let failed = 0;
const ok = (m) => console.log(`  ${G}✓${N} ${m}`);
const bad = (m) => { console.log(`  ${R}✗ ${m}${N}`); failed += 1; };
const step = (m) => console.log(`\n${C}▸ ${m}${N}`);

step('① 渠道码配置');
const channels = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'invites.json'), 'utf8'));
ok(`共 ${channels.length} 个渠道码：${channels.map((c) => c.code).join(' / ')}`);

step('② 已提交的二维码齐全');
if (!fs.existsSync(QR_DIR)) bad(`目录不存在：${QR_DIR}`);
else {
  const files = fs.readdirSync(QR_DIR).filter((f) => f.endsWith('.png'));
  const missing = channels.filter((c) => !files.includes(`${c.code}.png`));
  missing.length === 0
    ? ok(`${files.length} 张二维码齐全`)
    : bad(`缺二维码：${missing.map((c) => c.code).join(' / ')}`);
}

step('③ 重新生成并逐字节比对（证明编码的是现行地址）');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-qr-'));
try {
  execFileSync('node', [path.join(ROOT, 'scripts', 'make-qr.mjs'), BASE], {
    cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, QR_OUT: tmp, BASE_URL: BASE },
  });
  for (const { code, label } of channels) {
    const committed = path.join(QR_DIR, `${code}.png`);
    const fresh = path.join(tmp, `${code}.png`);
    if (!fs.existsSync(committed)) continue;
    if (!fs.existsSync(fresh)) { bad(`${code}：重新生成失败`); continue; }
    fs.readFileSync(committed).equals(fs.readFileSync(fresh))
      ? ok(`${code.padEnd(10)} ${label} → ${BASE}/?ref=${code}`)
      : bad(`${code}：与重新生成的不一致——二维码指向的地址可能已过期，跑 node scripts/make-qr.mjs ${BASE} 重打`);
  }
} catch (err) {
  bad(`重新生成失败：${err.message}`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${failed ? R : G}${failed ? `失败 ${failed} 项` : '渠道二维码指向校验全部通过'}${N}`);
process.exit(failed ? 1 : 0);
