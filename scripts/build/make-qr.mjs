#!/usr/bin/env node
/**
 * 渠道二维码生成器。
 *
 * 用途：发社群时二维码比链接触达率高得多（家长群/朋友圈尤其）。
 * 每个渠道一张 PNG，指向 http://<部署地址>/?ref=<渠道码>。
 *
 * 用法：node scripts/build/make-qr.mjs [BASE_URL]
 *   BASE_URL 默认 https://121.43.80.231/sceneguide
 */
import QRCode from 'qrcode';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.argv[2] ?? process.env.BASE_URL ?? 'https://121.43.80.231/sceneguide';
// 输出目录可用环境变量覆盖：验收脚本要重新生成到临时目录做**字节级比对**
// （解码二维码需要额外依赖，而"重新生成的与提交的一致"就足以证明编码内容没变）。
const OUT = process.env.QR_OUT ? path.resolve(process.env.QR_OUT) : path.resolve('提交材料/渠道二维码');
fs.mkdirSync(OUT, { recursive: true });

const refFile = path.resolve('config/invites.json');
const channels = JSON.parse(fs.readFileSync(refFile, 'utf8'));

for (const { code, label } of channels) {
  const url = `${BASE}/?ref=${code}`;
  const file = path.join(OUT, `${code}.png`);
  await QRCode.toFile(file, url, {
    width: 512,
    margin: 2,
    color: { dark: '#0b1020', light: '#ffffff' },
    errorCorrectionLevel: 'M',
  });
  console.log(`✓ ${label.padEnd(12)} ${file}  →  ${url}`);
}
console.log(`\n共 ${channels.length} 张。部署地址变更后重跑：node scripts/build/make-qr.mjs <新地址>`);
