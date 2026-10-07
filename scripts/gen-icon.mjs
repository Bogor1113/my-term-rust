// MyTerm 图标生成器
// 纯 Node 实现：SDF（有向距离场）渲染 + 极简 PNG 编码器，无第三方依赖。
// 设计：深海军蓝圆角方块 + 蓝青渐变发光 `>` 提示符 + 白色光标块 + 绿色状态点。
// 用法：node scripts/gen-icon.mjs [输出路径，默认 app-icon.png]
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

const SIZE = 1024;
const OUT = process.argv[2] || 'app-icon.png';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const sstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

// 圆角矩形 SDF（center + 半宽高 + 圆角半径）
function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r);
  const qy = Math.abs(py - cy) - (hh - r);
  const ox = Math.max(qx, 0);
  const oy = Math.max(qy, 0);
  return Math.min(Math.max(qx, qy), 0) + Math.sqrt(ox * ox + oy * oy) - r;
}

// 线段 SDF
function sdSeg(px, py, ax, ay, bx, by) {
  const pax = px - ax;
  const pay = py - ay;
  const bax = bx - ax;
  const bay = by - ay;
  const h = clamp((pax * bax + pay * bay) / (bax * bax + bay * bay), 0, 1);
  const dx = pax - bax * h;
  const dy = pay - bay * h;
  return Math.sqrt(dx * dx + dy * dy);
}

// ---------- 渲染 ----------
const out = Buffer.alloc(SIZE * SIZE * 4);
const CX = SIZE / 2;
const CY = SIZE / 2;
let idx = 0;
const t0 = Date.now();

for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    // 背景：对角渐变
    const t = clamp((x + y) / (2 * SIZE), 0, 1);
    let r = lerp(0x2a, 0x0a, t);
    let g = lerp(0x34, 0x0e, t);
    let b = lerp(0x50, 0x15, t);
    const bgd = sdRoundRect(x, y, CX, CY, SIZE / 2, SIZE / 2, 200);
    const bgcov = 1 - sstep(0, 1.6, bgd);
    if (bgcov <= 0) {
      idx += 4;
      continue;
    }
    // 顶部柔光
    const dhl = Math.sqrt((x - CX) ** 2 + (y - 380) ** 2);
    const hl = 1 - sstep(200, 780, dhl);
    r += 12 * hl;
    g += 16 * hl;
    b += 26 * hl;
    // 细微扫描线
    if (y % 14 < 2) {
      r *= 0.955;
      g *= 0.955;
      b *= 0.955;
    }
    // 边缘暗角
    const dv = Math.sqrt((x - CX) ** 2 + (y - CY) ** 2) / (SIZE * 0.62);
    const vig = 1 - 0.16 * sstep(0.55, 1.0, dv);
    r *= vig;
    g *= vig;
    b *= vig;

    let A = bgcov;
    let R = r;
    let G = g;
    let B = b;
    const over = (sr, sg, sb, sa) => {
      if (sa <= 0) return;
      const oa = sa + A * (1 - sa);
      R = (sr * sa + R * A * (1 - sa)) / oa;
      G = (sg * sa + G * A * (1 - sa)) / oa;
      B = (sb * sa + B * A * (1 - sa)) / oa;
      A = oa;
    };

    // 内描边
    const dr = Math.abs(sdRoundRect(x, y, CX, CY, SIZE / 2 - 44, SIZE / 2 - 44, 168)) - 3.5;
    const rcov = 1 - sstep(0, 1.2, dr);
    if (rcov > 0) over(150, 190, 255, 0.16 * rcov);

    // `>` 提示符（两段粗线 + 蓝青渐变 + 发光）
    const dA = sdSeg(x, y, 180, 278, 650, 512);
    const dB = sdSeg(x, y, 650, 512, 180, 746);
    const dSeg = Math.min(dA, dB);
    const dChev = dSeg - 46;
    if (dChev > 0) {
      const ga = (1 - sstep(6, 170, dChev)) * 0.5;
      if (ga > 0) over(96, 190, 255, ga);
    } else {
      const ct = clamp((x - 180) / (846 - 180), 0, 1);
      over(lerp(0x4f, 0x4f, ct), lerp(0x8c, 0xe0, ct), lerp(0xff, 0xe8, ct), 1);
    }

    // 光标块
    const dc = sdRoundRect(x, y, 790, 512, 56, 54, 20);
    if (dc > 0) {
      const ga = (1 - sstep(6, 150, dc)) * 0.45;
      if (ga > 0) over(96, 190, 255, ga);
    } else {
      over(0xe9, 0xf1, 0xff, 1);
    }

    // 绿色状态点
    const dd = Math.sqrt((x - 905) ** 2 + (y - 742) ** 2) - 30;
    if (dd > 0) {
      const ga = (1 - sstep(4, 85, dd)) * 0.5;
      if (ga > 0) over(63, 185, 80, ga);
    } else {
      over(0x3f, 0xb9, 0x50, 1);
    }

    out[idx++] = clamp(Math.round(R), 0, 255);
    out[idx++] = clamp(Math.round(G), 0, 255);
    out[idx++] = clamp(Math.round(B), 0, 255);
    out[idx++] = clamp(Math.round(A * 255), 0, 255);
  }
}

// ---------- PNG 编码 ----------
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}

function encodePng(w, h, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // 位深
  ihdr[9] = 6; // 颜色类型 RGBA
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // 滤波类型 0
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

writeFileSync(OUT, encodePng(SIZE, SIZE, out));
console.log(`✓ 图标已生成：${OUT}（${SIZE}×${SIZE}，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s）`);
