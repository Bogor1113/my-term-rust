// 校验 index.html 内联的「启动期底色」表与 themes.ts 的 UI_PALETTES 保持一致。
//
// 背景：首帧底色必须内联同步执行（等不到 ES 模块加载），所以 index.html 里
//  unavoidably 复制了一份「主题 id → bg」映射。这份副本一旦与 themes.ts 漂移，
// 就会出现「重启瞬间闪一下错误底色」——症状隐蔽、不易定位。此脚本把该风险
// 钉死在构建阶段：不一致就直接失败。
//
// 用法：node scripts/check-index-bg.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const html = readFileSync(join(root, 'index.html'), 'utf8');
const themesSrc = readFileSync(join(root, 'src/themes.ts'), 'utf8');

// 从 index.html 解析 BG 映射（形如 ocean: '#0e1116',）
const bgBlock = html.match(/var BG = \{([\s\S]*?)\};/);
if (!bgBlock) {
  console.error('✗ index.html 中未找到 `var BG = { ... };` 映射表');
  process.exit(1);
}
const htmlBg = {};
// 键可能是带引号的（'classic-green'）或不带引号的（ocean），两种都要认
for (const m of bgBlock[1].matchAll(/'?([\w-]+)'?:\s*'(#[0-9a-fA-F]{3,8})'/g)) {
  htmlBg[m[1]] = m[2].toLowerCase();
}

// 从 themes.ts 解析每个主题 makeUi({ ... bg: '...' }) 的 bg
// 形如：  ocean: makeUi({\n    bg: '#0e1116',
const tsBg = {};
for (const m of themesSrc.matchAll(/(?:^|\n)\s*'?([\w-]+)'?:\s*makeUi\(\{([\s\S]*?)\n\s*\}\),/g)) {
  const id = m[1];
  const bgm = m[2].match(/bg:\s*'(#[0-9a-fA-F]{3,8})'/);
  if (bgm) tsBg[id] = bgm[1].toLowerCase();
}

const ids = Object.keys(tsBg);
const problems = [];

if (!ids.length) {
  console.error('✗ 未能从 themes.ts 解析出任何主题 bg（正则可能已过期）');
  process.exit(1);
}

for (const id of ids) {
  const t = tsBg[id];
  const h = htmlBg[id];
  if (!h) problems.push(`index.html 缺少主题 "${id}"（themes.ts 中为 ${t}）`);
  else if (h !== t) problems.push(`主题 "${id}" 底色不一致：index.html=${h} / themes.ts=${t}`);
}

for (const id of Object.keys(htmlBg)) {
  if (!tsBg[id]) problems.push(`index.html 多出主题 "${id}"（themes.ts 中已不存在）`);
}

console.log(`index.html 启动底色表: ${Object.keys(htmlBg).length} 项`);
console.log(`themes.ts 主题 bg      : ${ids.length} 项（${ids.join(', ')}）`);

if (problems.length) {
  console.error('\n✗ 校验失败：');
  for (const p of problems) console.error('  - ' + p);
  console.error('\n请同步 index.html 内联 <script> 中的 BG 映射后再构建。');
  process.exit(1);
}
console.log('\n✓ 启动底色与 themes.ts 完全一致');
