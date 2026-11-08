#!/usr/bin/env node
/**
 * 生成 PWA 图标（无第三方依赖，纯 PNG 编码）。
 *
 * 为什么需要：Vibe Pay 赛道的交付形态包含「桌面应用」。
 * 把作品做成可安装的 PWA（manifest + service worker），
 * 就能以桌面应用形态被安装到系统里，而不必为 Electron 付出额外体积与维护成本。
 *
 * 图标设计：蓝青渐变圆角方块 + 一条白色路线折线 + 两个端点，
 * 与站点「三维问路」的品牌语言一致。
 *
 * 用法：node scripts/make-icons.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const OUT_DIR = path.resolve(process.cwd(), 'public');

/* ── 最小 PNG 编码器 ─────────────────────────────────────── */

function crc32(buf) {
  let c;
  const table = crc32.table ?? (crc32.table = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })());
  let crc = -1;
  for (let i = 0; i < buf.length; i += 1) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type RGBA
  ihdr[10] = 0;  // compression
  ihdr[11] = 0;  // filter
  ihdr[12] = 0;  // interlace
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ── 图标绘制 ─────────────────────────────────────────────── */

function lerp(a, b, t) { return a + (b - a) * t; }

function drawIcon(size) {
  const px = Buffer.alloc(size * size * 4);
  const s = (v) => v * size; // 归一化坐标

  // 圆角矩形的内部判定
  const radius = s(0.22);
  const inside = (x, y) => {
    const rx = Math.min(x, size - x);
    const ry = Math.min(y, size - y);
    if (rx >= radius || ry >= radius) return true;
    const dx = radius - rx;
    const dy = radius - ry;
    return dx * dx + dy * dy <= radius * radius;
  };

  // 路线折线（归一化坐标）
  const route = [
    [0.24, 0.76], [0.40, 0.55], [0.56, 0.62], [0.76, 0.28],
  ];
  const waypoints = [route[0], route[route.length - 1]];

  const distToSeg = (px_, py_, ax, ay, bx, by) => {
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 === 0 ? 0 : ((px_ - ax) * dx + (py_ - ay) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px_ - (ax + t * dx), py_ - (ay + t * dy));
  };

  const lineW = s(0.055);
  const dotR = s(0.075);

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const i = (y * size + x) * 4;
      if (!inside(x + 0.5, y + 0.5)) {
        px[i] = 0; px[i + 1] = 0; px[i + 2] = 0; px[i + 3] = 0;
        continue;
      }
      // 背景：左上 → 右下 蓝青渐变
      const t = (x / size + y / size) / 2;
      let r = lerp(47, 34, t);
      let g = lerp(123, 211, t);
      let b = lerp(255, 166, t);

      // 路线白线
      let onRoute = false;
      for (let k = 0; k < route.length - 1; k += 1) {
        const d = distToSeg(
          x + 0.5, y + 0.5,
          s(route[k][0]), s(route[k][1]),
          s(route[k + 1][0]), s(route[k + 1][1]),
        );
        if (d <= lineW / 2) { onRoute = true; break; }
      }
      // 端点
      for (const [wx, wy] of waypoints) {
        if (Math.hypot(x + 0.5 - s(wx), y + 0.5 - s(wy)) <= dotR) { onRoute = true; break; }
      }

      if (onRoute) { r = 255; g = 255; b = 255; }

      px[i] = Math.round(r);
      px[i + 1] = Math.round(g);
      px[i + 2] = Math.round(b);
      px[i + 3] = 255;
    }
  }
  return encodePng(size, size, px);
}

for (const size of [192, 512]) {
  const buf = drawIcon(size);
  const file = path.join(OUT_DIR, `icon-${size}.png`);
  fs.writeFileSync(file, buf);
  console.log(`✓ ${path.relative(process.cwd(), file)}  ${size}×${size}  ${(buf.length / 1024).toFixed(1)}KB`);
}
