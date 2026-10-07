# MyTerm

> 一款面向运维与大数据场景的 Windows 桌面终端工具 —— SSH 终端 + SFTP 文件管理 + 系统监控 + Hadoop 集群面板，全部集成在一个界面里。

**MyTerm** 基于 **Tauri 2 + React 19** 构建，底层用 Rust 的 `russh` 实现 SSH 协议，
终端渲染交给 `xterm.js`。相比传统 SSH 客户端，它把"连上服务器"和"看服务器状态"两件事合到了一起：
左边敲命令，右边实时看 CPU / 内存 / 集群服务健康度，下面拖文件。

---

## 功能特性

### 终端与连接

| 能力 | 说明 |
| --- | --- |
| 多会话标签 | 同时连多台服务器，标签页切换，会话状态持久保持 |
| 分屏视图 | 一屏并列多个会话，方便对照操作 |
| 会话分组 | 按项目 / 环境分组管理主机，支持快速筛选 |
| 本地端口转发 | 图形化管理 SSH 隧道，一键添加 / 移除 |
| 代码片段库 | 常用命令存为片段，点击直接下发到终端 |
| 会话日志 | 可选开启，把会话输出落盘留存 |

### 文件传输（SFTP）

- 目录树浏览、上传、下载（带进度）
- 新建目录、重命名、删除
- 同名文件冲突时弹出选择（覆盖 / 跳过 / 重命名）

### 资源监控

- 实时 CPU / 内存 / 磁盘曲线
- **按需采集**：只采集"当前正在查看"的会话，非活跃会话不做轮询 ——
  避免后台会话白白消耗本机 CPU 和远端负载

### 集群监控（Hadoop 生态）

| 模块 | 内容 |
| --- | --- |
| 服务状态 | HDFS / YARN / Hive / DolphinScheduler / MySQL / Spark 的启停与健康检测 |
| 服务操作 | 一键启动 / 停止 / 重启，查看服务日志 |
| HDFS 浏览 | 目录浏览、容量汇总、DataNode 列表与块分布 |
| YARN 面板 | 应用列表（含运行状态）、在线节点、集群指标，支持 Kill 应用 |
| JVM 指标 | NameNode JVM 堆内存 / GC / 线程等运行时数据 |

### AI 助手

内置 AI 对话面板，可在终端旁边直接问问题（比如"这条报错什么意思"）。

- 走 **OpenAI 兼容接口**，DeepSeek / Qwen / 通义 / GLM 等主流服务都能接
- 只需配置 `BaseURL` + `API Key` + 模型名
- 请求由 **Rust 后端发出**，绕开浏览器 CORS 限制，且 **API Key 不会打进前端产物**

### 界面

- 无边框窗口 + 自绘标题栏
- 多套主题可切换
- **窗口自适应**：启动时按当前显示器工作区自动缩放定位，
  低分辨率 / 高 DPI 缩放的机器上也不会出现窗口超出屏幕、关闭按钮点不到的情况

---

## 技术栈

| 层 | 选型 |
| --- | --- |
| 桌面框架 | Tauri 2 |
| 后端语言 | Rust 2021 |
| SSH / SFTP | `russh` 0.62、`russh-sftp` 2、`ssh-key` |
| 异步运行时 | Tokio |
| HTTP 客户端 | `reqwest`（流式，用于 AI 对话） |
| 前端 | React 19 + TypeScript |
| 构建工具 | Vite 7 |
| 终端渲染 | xterm.js 5（fit / search 插件） |
| 打包 | Tauri Bundler（NSIS） |

---

## 目录结构

```
my-term-rust/
├── src/                          # 前端（React 19 + TS）
│   ├── App.tsx                   # 主界面与全局状态
│   ├── api.ts                    # 后端命令封装
│   ├── types.ts                  # 类型定义
│   ├── themes.ts                 # 主题配置
│   ├── styles.css
│   └── components/
│       ├── TerminalTab.tsx       # 终端标签（xterm 挂载）
│       ├── Sidebar.tsx           # 侧边会话列表
│       ├── ConnectionModal.tsx   # 新建/编辑连接
│       ├── SftpPanel.tsx         # SFTP 文件管理
│       ├── ResourceMonitor.tsx   # 资源曲线
│       ├── ClusterPanel.tsx      # Hadoop 集群面板
│       ├── AIPanel.tsx           # AI 助手
│       ├── ForwardPanel.tsx      # 端口转发
│       ├── SnippetsPanel.tsx     # 代码片段
│       ├── GroupManager.tsx      # 会话分组
│       ├── SessionPicker.tsx     # 会话选择
│       ├── SplitPicker.tsx       # 分屏选择
│       └── TitleBar.tsx          # 自绘标题栏
├── src-tauri/                    # 后端（Rust）
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   ├── capabilities/
│   └── src/
│       ├── lib.rs                # 应用装配、状态、窗口适配
│       ├── ssh.rs                # SSH 连接 / 输入 / PTY / 端口转发 / 日志
│       ├── sftp.rs               # 文件浏览与传输
│       ├── system.rs             # 远程资源采集
│       ├── cluster.rs            # Hadoop 集群监控
│       └── ai.rs                 # AI 流式对话
├── scripts/                      # 构建辅助脚本
├── bump-version.mjs              # 版本号统一提升
├── 一键打包.bat                   # Windows 一键出包
└── index.html
```

---

## 快速开始

### 环境要求

- Node.js ≥ 18
- Rust ≥ 1.78（`cargo`）
- Windows 10/11（WebView2 运行时，Win11 已内置）

### 开发调试

```bash
npm install
npm run tauri dev
```

### 构建发布

```bash
npm run tauri build
```

Windows 上一键打包：

```bat
一键打包.bat
```

或使用 PowerShell 脚本：

```powershell
scripts\build-release.ps1
```

产物输出至 `src-tauri/target/release/bundle/`。

---

## 使用说明

1. 点击侧边栏 **+** 新建连接，填主机 / 端口 / 用户名 / 密码或密钥
2. 连接成功后即可在终端区操作
3. 打开右侧面板切换到 **SFTP / 资源监控 / 集群 / AI** 等页签
4. 集群面板需要目标服务器上已部署对应服务（HDFS / YARN / Hive 等）

> AI 助手需要自行准备一个 OpenAI 兼容的 API Key，在面板内配置后即可使用。

---

## 说明

- 本工具通过 SSH 协议连接你**自己的**服务器，不在任何地方中转、上传或收集你的连接信息与命令内容。
- 请仅用于连接你拥有合法授权的设备，遵守所在组织与目标主机的安全策略。
