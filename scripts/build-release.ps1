# MyTerm 一键打包脚本（构建 Windows exe）
# 说明：bat 薄壳调用本脚本；PowerShell 原生 Unicode，无 cmd 中文编码问题
$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path | Split-Path -Parent
Set-Location $root

Write-Host "============================================================"
Write-Host "  MyTerm 一键打包（构建 Windows exe）"
Write-Host "============================================================"
Write-Host ""

# ---- 检查环境 ----
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "[错误] 未检测到 Node.js，请先安装 https://nodejs.org 后重试"
    Read-Host "按任意键退出"
    exit 1
}
if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
    Write-Host "[错误] 未检测到 Rust 工具链，请先安装 https://rustup.rs 后重试"
    Read-Host "按任意键退出"
    exit 1
}

# ---- 1. 版本号自动递增（patch +1）----
Write-Host "[1/4] 自动递增版本号..."
node bump-version.mjs
if ($LASTEXITCODE -ne 0) {
    Write-Host "[错误] 版本号递增失败"
    Read-Host "按任意键退出"
    exit 1
}

# ---- 2. 安装前端依赖（仅首次）----
if (-not (Test-Path node_modules)) {
    Write-Host "[2/4] 未找到 node_modules，正在安装前端依赖..."
    npm install
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[错误] npm install 失败，请检查网络后重试"
        Read-Host "按任意键退出"
        exit 1
    }
}
else {
    Write-Host "[2/4] 前端依赖已存在，跳过安装"
}

# ---- 3. 构建（tsc + vite + cargo release，--no-bundle 只出 exe 不打安装包）----
Write-Host "[3/4] 开始构建（仅生成免安装 exe，跳过安装包），首次需编译 Rust 依赖约 5~15 分钟 ..."
npm run tauri build -- --no-bundle
if ($LASTEXITCODE -ne 0) {
    Write-Host "[错误] 构建失败，请查看上方错误信息"
    Read-Host "按任意键退出"
    exit 1
}

# ---- 4. 汇总产物 ----
Write-Host "[4/4] 构建成功！"
Write-Host ""
if (-not (Test-Path build-output)) { New-Item -ItemType Directory -Path build-output | Out-Null }
$ver = "0.0.0"
if (Test-Path .version) { $ver = (Get-Content .version -Raw).Trim() }
Copy-Item "src-tauri\target\release\MyTerm.exe" "build-output\MyTerm.exe" -Force -ErrorAction SilentlyContinue
Copy-Item "src-tauri\target\release\MyTerm.exe" "build-output\MyTerm_$ver.exe" -Force -ErrorAction SilentlyContinue
Write-Host "生成位置："
Write-Host "  build-output\MyTerm_$ver.exe      免安装主程序（带版本号，新图标立即生效）"
Write-Host "  build-output\MyTerm.exe            免安装主程序（固定名，若图标未刷新请重启资源管理器）"
Write-Host ""
Write-Host "正在刷新资源管理器图标缓存..."
ie4uinit.exe -show 2>$null | Out-Null
Write-Host "打包完成，按任意键关闭窗口..."
Read-Host "按任意键退出"
