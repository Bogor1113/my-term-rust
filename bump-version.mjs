// 打包前自动递增版本号（patch +1），同步更新：
//   - src-tauri/tauri.conf.json（Tauri 打包版本）
//   - src-tauri/Cargo.toml（Tauri 要求与 tauri.conf.json 版本一致，否则构建报错）
//   - package.json（保持一致）
// 用法：node bump-version.mjs [可选: 显式指定完整版本号，如 1.2.0]
import { readFileSync, writeFileSync } from 'node:fs';

const bump = (v) => {
  const parts = String(v).split('.').map((n) => parseInt(n, 10) || 0);
  while (parts.length < 3) parts.push(0);
  parts[2] += 1;
  return parts.join('.');
};

const explicit = process.argv[2];
const confPath = 'src-tauri/tauri.conf.json';
const conf = JSON.parse(readFileSync(confPath, 'utf8'));
const newVersion = explicit || bump(conf.version);
if (!/^\d+\.\d+\.\d+$/.test(newVersion)) {
  console.error('[错误] 版本号格式无效：' + newVersion);
  process.exit(1);
}

// 更新 tauri.conf.json（保持 2 空格缩进与原有格式）
conf.version = newVersion;
// 窗口标题自动追加版本号（去掉旧的版本后缀，如 "myterm-波哥自研 v0.1.2" → v0.1.3）
const titleBase = String(conf.app?.windows?.[0]?.title || '').replace(/\s*v?\d+\.\d+\.\d+\s*$/, '') || 'myterm';
if (conf.app?.windows?.[0]) {
  conf.app.windows[0].title = `${titleBase} v${newVersion}`;
}
writeFileSync(confPath, JSON.stringify(conf, null, 2) + '\n', 'utf8');

// 更新 Cargo.toml / package.json 中的 version 字段
const patch = (file, re) => {
  const text = readFileSync(file, 'utf8');
  // 用 test 判断是否真正匹配（不能靠替换前后是否变化：
  // 传入的版本号与文件当前版本相同时替换结果不变，会误报）
  if (!re.test(text)) {
    console.error(`[错误] 未在 ${file} 中找到 version 字段`);
    process.exit(1);
  }
  writeFileSync(file, text.replace(re, `$1${newVersion}$2`), 'utf8');
};
patch('src-tauri/Cargo.toml', /^(version\s*=\s*")[^"]+(")/m);
patch('package.json', /^(\s*"version"\s*:\s*")[^"]+(")/m);

// 记录版本号供打包脚本读取（带版本号的新文件名可避免资源管理器图标缓存）
writeFileSync('.version', newVersion + '\n', 'utf8');

console.log('自动递增版本号 → ' + newVersion);
