//! SSH 模块：基于 russh 的远程终端连接管理
//!
//! 架构：每个连接由「会话处理器（Handle）」+「后台任务」组成。
//! - `Handle` 存放在全局状态中，供 SFTP 等操作复用同一个已认证连接；
//! - 后台任务持有 shell 通道的读写半部，负责把服务器输出流式转发给前端，
//!   并消费前端通过 Tauri 命令发来的输入 / 调整尺寸 / 断开指令。

use std::collections::HashMap;
use std::io::Write;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use tauri::{AppHandle, Manager, State};

use crate::{system, AppState};

/// SSH 客户端处理器。
///
/// 主机密钥采用 TOFU（Trust On First Use）校验：
/// - 首次连接某台服务器：记录其指纹并放行；
/// - 之后指纹一致：放行；
/// - 指纹变化：**拒绝**并报错，要求用户显式确认。
///
/// 原实现无条件 `Ok(true)`，等价于"接受任何主机密钥"。这意味着处在公共 Wi-Fi、
/// 被 ARP/DNS 投毒，或任何能坐到网络路径上的攻击者，可以用一个假服务器透明地
/// 终结会话，直接拿到用户的**密码**（本客户端只走 authenticate_password）
/// 以及之后键入的全部内容。对一个桌面级 SSH 客户端来说这是最高危的缺陷。
#[derive(Clone)]
pub struct Client {
    /// 主机指纹表：`host:port` -> SHA256 指纹
    known: Arc<std::sync::RwLock<HashMap<String, String>>>,
    /// 尚未记录指纹的主机（本次连接需要"首次信任"）
    to_accept: Arc<std::sync::Mutex<Vec<String>>>,
    /// 已加载的指纹表文件路径
    path: std::path::PathBuf,
    /// 本次连接的目标 `host:port`，用于在密钥校验时定位条目
    endpoint: String,
}

/// known_hosts 存放位置：与 ssh 客户端保持一致的约定（用户主目录/.ssh/known_hosts），
/// 这样 MyTerm 与 OpenSSH 可以共用同一份指纹记录。
fn known_hosts_path() -> std::path::PathBuf {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(std::path::PathBuf::from);
    let base = match home {
        Some(h) if !h.as_os_str().is_empty() => h,
        _ => std::env::temp_dir(),
    };
    base.join(".ssh").join("known_hosts")
}

/// 解析 known_hosts 文本：`host:port SHA256:...`（每行一条）
fn parse_known_hosts(text: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let mut parts = line.split_whitespace();
        if let (Some(host), Some(fp)) = (parts.next(), parts.next()) {
            map.insert(host.to_string(), fp.to_string());
        }
    }
    map
}

impl Client {
    fn new(endpoint: String) -> Self {
        let path = known_hosts_path();
        // 记录加载失败但仍继续：文件损坏不应该让用户完全无法连接，
        // 只是退化成"本次会话内重新信任"。
        let known = match std::fs::read_to_string(&path) {
            Ok(text) => parse_known_hosts(&text),
            Err(e) => {
                if e.kind() != std::io::ErrorKind::NotFound {
                    eprintln!("[ssh] 读取 known_hosts 失败（{path:?}）：{e}，本次会话将重新信任");
                }
                HashMap::new()
            }
        };
        Self {
            known: Arc::new(std::sync::RwLock::new(known)),
            to_accept: Arc::new(std::sync::Mutex::new(Vec::new())),
            path,
            endpoint,
        }
    }

    /// 校验一台服务器的主机密钥
    fn verify(&self, endpoint: &str, key: &ssh_key::PublicKey) -> Result<(), String> {
        use ssh_key::HashAlg;
        let fp = key.fingerprint(HashAlg::Sha256).to_string();

        {
            let known = self.known.read().unwrap_or_else(|e| e.into_inner());
            match known.get(endpoint) {
                Some(expected) if *expected == fp => return Ok(()),
                Some(expected) => {
                    return Err(format!(
                        "\n主机密钥与首次记录不一致，已拒绝连接。\n  服务器：{endpoint}\n  已记录：{expected}\n  本次收到：{fp}\n\n若确认是服务器重装或更换了密钥，可删除 {} 中对应行后重试。",
                        self.path.display()
                    ));
                }
                None => {}
            }
        }

        // 首次见到：先记录，等认证成功后再落盘（落盘见 verify_and_persist）
        self.to_accept
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(fp.clone());
        Ok(())
    }

    /// 连接建立成功后，把本次新信任的主机写入 known_hosts
    fn persist(&self, endpoint: &str) {
        let pending = {
            let mut guard = self.to_accept.lock().unwrap_or_else(|e| e.into_inner());
            if guard.is_empty() {
                return;
            }
            guard.drain(..).collect::<Vec<_>>()
        };
        let fp = pending.last().cloned().unwrap_or_default();
        {
            let mut known = self.known.write().unwrap_or_else(|e| e.into_inner());
            known.insert(endpoint.to_string(), fp.clone());
        }
        if let Some(parent) = self.path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let mut line = format!("{endpoint} {fp}\n");
        // 追加而非全量重写：避免并发连接互相覆盖
        if let Ok(existing) = std::fs::read_to_string(&self.path) {
            let kept: Vec<&str> = existing
                .lines()
                .filter(|l| !l.split_whitespace().next().map(|h| h == endpoint).unwrap_or(false))
                .collect();
            if !kept.is_empty() {
                line = format!("{}\n{line}", kept.join("\n"));
            }
        }
        if let Err(e) = std::fs::write(&self.path, line) {
            eprintln!("[ssh] 写入 known_hosts 失败（{}）：{e}", self.path.display());
        }
    }
}

impl russh::client::Handler for Client {
    type Error = russh::Error;

    async fn check_server_key(&mut self, key: &ssh_key::PublicKey) -> Result<bool, Self::Error> {
        self.verify(&self.endpoint, key)
            .map_err(|e| {
                eprintln!("[ssh] 主机密钥校验失败：{e}");
                russh::Error::UnknownKey
            })
            .map(|_| true)
    }
}

/// 后台任务消费的会话指令
#[derive(Debug)]
pub enum SessionCmd {
    /// 终端输入（base64 解码后的原始字节）
    Input(Vec<u8>),
    /// 终端尺寸变化
    Resize(u32, u32),
    /// 主动断开
    Shutdown,
}

/// 会话状态
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SessionStatus {
    Connected,
    Closed,
}

/// 一个已建立连接的会话
pub struct SshConn {
    pub id: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    /// 会话句柄包装在 Arc 中，供监控等后台任务克隆后短暂持有，
    /// 避免长时间占用全局 sessions 锁导致输入命令被阻塞
    pub handle: Arc<tokio::sync::Mutex<russh::client::Handle<Client>>>,
    pub cmd_tx: tokio::sync::mpsc::Sender<SessionCmd>,
    pub status: SessionStatus,
    /// 最近一段终端输出环形缓冲（供 AI 分析上下文 / 引用输出使用）
    pub output_ring: Arc<tokio::sync::Mutex<Vec<u8>>>,
    /// 本次连接的代次标识（全局单调递增）。
    ///
    /// 用于让后台任务在收尾时确认"全局会话表里登记的仍是自己"，
    /// 从而不会把同 id 的新连接误删（见 connect_ssh 中的说明）。
    pub gen: u64,
}

/// 会话代次计数器
static SESSION_GEN: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

/// 通道关闭原因（供前端决定是否自动重连）
#[derive(Clone, Copy, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CloseReason {
    /// shell 正常退出（用户输入 exit 等）
    Eof,
    /// 远端关闭通道
    Close,
    /// 连接异常断开（网络问题 / 服务器重启等）
    Drop,
}

/// 推送给前端的终端事件（通过 Tauri IPC Channel 流式传输）
#[derive(Clone, serde::Serialize)]
#[serde(tag = "type", content = "data", rename_all = "camelCase")]
pub enum TerminalEvent {
    /// 服务器输出数据（base64 编码，避免二进制转义问题）
    Data(String),
    /// 通道已关闭（携带关闭原因）
    Close { reason: CloseReason },
    /// 后端检测到的会话级错误（如写入超时）。前端据此提示用户，
    /// 而不必靠"终端突然不响应"去猜。
    Error(String),
}

/// 会话日志配置。设置界面已移除：日志默认开启，固定写入用户主目录下的
/// myterm-logs 目录（Windows: %USERPROFILE%\myterm-logs，Unix: ~/myterm-logs）。
#[derive(Clone)]
pub struct SessionLogConfig {
    pub enabled: bool,
    pub dir: std::path::PathBuf,
}

impl Default for SessionLogConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            dir: default_log_dir(),
        }
    }
}

/// 默认日志目录：用户主目录下的 myterm-logs（取不到主目录时退回当前目录）
fn default_log_dir() -> std::path::PathBuf {
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(std::path::PathBuf::from);
    home.map(|h| h.join("myterm-logs"))
        .unwrap_or_else(|| std::path::PathBuf::from("."))
}

/// 一个本地端口转发条目
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForwardInfo {
    /// 所属会话 id
    pub session_id: String,
    /// 会话主机
    pub host: String,
    /// 本地监听端口
    pub local_port: u16,
    /// 转发目标主机（远端可达地址）
    pub remote_host: String,
    /// 转发目标端口
    pub remote_port: u16,
}

/// 转发后台任务句柄
pub struct ForwardEntry {
    pub info: ForwardInfo,
    pub task: tauri::async_runtime::JoinHandle<()>,
    /// 取消信号发送端。
    ///
    /// 必须持有它：一旦所有 Sender 被 drop，Receiver 的 `changed()` 会**立刻且永久地**
    /// 返回 `Err`（tokio 源码 `watch.rs::maybe_changed`：版本号未变且 `state.is_closed()`
    /// 时同步返回 `Some(Err)`），`select!` 于是每一轮都立即就绪 —— 监听循环退化成
    /// 100% CPU 忙等，且永远等不到真正的取消。
    pub cancel: tokio::sync::watch::Sender<bool>,
    /// 正在运行的中继任务（每个本地连接一个）。
    ///
    /// 必须持有：`tokio::spawn` 出来的子任务不属于监听任务，
    /// 只 abort 监听任务对它们无效。没有这份句柄，移除转发后
    /// copy_bidirectional 仍会持有本地 socket 与远端通道直到对端关闭，
    /// 端口与缓冲区跟着一起泄漏。
    /// 正在运行的中继任务集合。
    ///
    /// 必须持有：`tokio::spawn` 出来的子任务不属于监听任务，
    /// 只 abort 监听任务对它们无效。没有这份句柄，移除转发后
    /// copy_bidirectional 仍会持有本地 socket 与远端通道直到对端关闭，
    /// 端口与缓冲区跟着一起泄漏。
    ///
    /// 用 JoinSet 而非 Vec：它会自动回收已结束的任务，
    /// 而 Vec 需要额外的"是否已结束"判断（而 Tauri 的 JoinHandle
    /// 并没有暴露 is_finished）。
    pub relays: std::sync::Arc<tokio::sync::Mutex<tokio::task::JoinSet<()>>>,
}

/// 建立 SSH 连接，认证后打开带 PTY 的交互式 shell，并启动后台转发任务
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn connect_ssh(
    state: State<'_, AppState>,
    app: AppHandle,
    session_id: String,
    host: String,
    port: u16,
    username: String,
    password: String,
    cols: u32,
    rows: u32,
    on_data: tauri::ipc::Channel<TerminalEvent>,
) -> Result<(), String> {
    let config = Arc::new(russh::client::Config {
        keepalive_interval: Some(Duration::from_secs(30)),
        keepalive_max: 3,
        nodelay: true,
        ..russh::client::Config::default()
    });

    let endpoint = format!("{host}:{port}");
    // 保留一份克隆：russh 的 Handle 不暴露 handler，
    // 认证成功后需要用它把"本次新信任的主机"落盘。
    let client = Client::new(endpoint.clone());
    let tracker = client.clone();
    let mut handle = tokio::time::timeout(
        Duration::from_secs(15),
        russh::client::connect(config, (host.as_str(), port), client),
    )
    .await
    .map_err(|_| format!("连接 {host}:{port} 超时（15 秒）"))?
    .map_err(|e| format!("无法连接到 {host}:{port}：{e}"))?;

    let auth = handle
        .authenticate_password(username.as_str(), password.as_str())
        .await
        .map_err(|e| format!("认证过程出错：{e}"))?;
    if !auth.success() {
        return Err("认证失败：用户名或密码不正确".to_string());
    }
    // 仅在认证成功后才落盘新信任的主机：连接失败/密码错误不应该在
    // known_hosts 里留下痕迹。
    tracker.persist(&endpoint);

    let channel = handle
        .channel_open_session()
        .await
        .map_err(|e| format!("打开会话通道失败：{e}"))?;
    channel
        .request_pty(true, "xterm-256color", cols, rows, 0, 0, &[])
        .await
        .map_err(|e| format!("请求 PTY 失败：{e}"))?;
    channel
        .request_shell(true)
        .await
        .map_err(|e| format!("启动远程 shell 失败：{e}"))?;

    let (read_half, write_half) = channel.split();
    let (cmd_tx, cmd_rx) = tokio::sync::mpsc::channel::<SessionCmd>(256);
    let gen = SESSION_GEN.fetch_add(1, std::sync::atomic::Ordering::Relaxed);

    // 会话输出环形缓冲（AI 上下文）：后台任务与 SshConn 共享同一 Arc
    let output_ring: Arc<tokio::sync::Mutex<Vec<u8>>> =
        Arc::new(tokio::sync::Mutex::new(Vec::new()));

    spawn_session_task(
        read_half,
        write_half,
        cmd_rx,
        on_data,
        app.clone(),
        session_id.clone(),
        host.clone(),
        output_ring.clone(),
        gen,
    );

    let conn = SshConn {
        id: session_id.clone(),
        host: host.clone(),
        port,
        username: username.clone(),
        handle: Arc::new(tokio::sync::Mutex::new(handle)),
        cmd_tx,
        status: SessionStatus::Connected,
        output_ring,
        gen,
    };
    // 拒绝复用仍存活的 session_id。
    // 旧实现是无条件覆盖，后果是双向的：
    //  1) 旧会话的 SshConn 被 drop → cmd_rx 收到 None → 旧后台任务收尾时执行
    //     `sessions.remove(&session_id)`，把**刚写入的新会话**从表中删除；
    //     于是新连接仍在跑，但所有命令都报"会话不存在"，表现为"终端卡死"。
    //  2) 同理 monitor_cancels 也会被旧任务误删，新会话的监控无法再被取消。
    {
        let mut sessions = state.sessions.lock().await;
        if sessions.contains_key(&session_id) {
            return Err(format!("会话 {session_id} 已存在，请先断开后再重连"));
        }
        sessions.insert(session_id.clone(), conn);
    }

    // 启动远程系统监控
    let (cancel_tx, cancel_rx) = tokio::sync::watch::channel(false);
    {
        let mut cancels = state.monitor_cancels.lock().await;
        cancels.insert(session_id.clone(), cancel_tx);
    }
    system::start_session_monitor(&app, &session_id, cancel_rx);

    Ok(())
}

/// 数据合并缓冲上限：超过该值丢弃最旧数据，防止内存无限增长
const DATA_BUF_CAP: usize = 256 * 1024;
/// 达到该阈值即立即刷新（无需等到定时器），保证吞吐优先
const DATA_BUF_FLUSH_AT: usize = 128 * 1024;
/// 定时刷新间隔：把高频小块输出合并为低频大消息，降低 IPC 消息数
const DATA_FLUSH_INTERVAL: Duration = Duration::from_millis(50);
/// 向后端写入操作的超时时间（data_bytes / window_change）。
/// 远端 TCP 流量控制或服务器停止读取时，写入可能无限阻塞。
const WRITE_TIMEOUT: Duration = Duration::from_secs(30);

/// 把缓冲数据一次性发送给前端（base64 编码），并清空缓冲。
fn flush_data_buf(
    out: &tauri::ipc::Channel<TerminalEvent>,
    buf: &mut Vec<u8>,
) {
    use base64::engine::general_purpose::STANDARD as B64;
    use base64::Engine as _;
    if buf.is_empty() {
        return;
    }
    let _ = out.send(TerminalEvent::Data(B64.encode(buf.as_slice())));
    buf.clear();
}

/// 后台任务：双向转发终端数据
fn spawn_session_task(
    mut read_half: russh::ChannelReadHalf,
    write_half: russh::ChannelWriteHalf<russh::client::Msg>,
    mut cmd_rx: tokio::sync::mpsc::Receiver<SessionCmd>,
    out: tauri::ipc::Channel<TerminalEvent>,
    app: AppHandle,
    session_id: String,
    host: String,
    output_ring: Arc<tokio::sync::Mutex<Vec<u8>>>,
    // 本任务所对应连接的代次标识。收尾时据此判断"全局会话表里登记的仍是
// 不是自己"，避免旧任务把同 id 的新会话连同其转发/监控一起误删。
gen: u64,
) {
    tauri::async_runtime::spawn(async move {
        // 输出合并缓冲：把高频数据块合并后再发送，避免 IPC 消息洪泛
        let mut data_buf: Vec<u8> = Vec::with_capacity(DATA_BUF_CAP);
        let mut flush_timer = tokio::time::interval(DATA_FLUSH_INTERVAL);
        flush_timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        // 跳过首次立即触发的 tick，避免空缓冲空转
        flush_timer.tick().await;

        // 会话日志：若已开启，为本次会话打开日志文件（仅当配置可用时写一次）
        let log_cfg = {
            let state = app.state::<AppState>();
            let cfg = state.session_log.read().await;
            cfg.clone()
        };
        // 会话日志的发送端。数据只经由有界通道交给专用写盘线程，
// 终端转发这条异步任务上不再有任何阻塞的文件 IO。
        let mut log_tx: Option<std::sync::mpsc::SyncSender<Vec<u8>>> = None;
        // host / session_id 都参与拼文件名，必须过滤路径分隔符与 ..，
        // 否则前端可控的 session_id 里的 ".." 或 "\" 可以让日志写到日志目录之外。
        let file_name = format!(
            "{}_{}.log",
            sanitize_path_component(&host),
            sanitize_path_component(&session_id)
        );
        if log_cfg.enabled && !log_cfg.dir.as_os_str().is_empty() {
            // 建目录与开文件都是阻塞系统调用，挪到 spawn_blocking：
            // 它们跑在这台机器负责转发终端输出的 tokio worker 上。
            let log_dir = log_cfg.dir.clone();
            let f_name = file_name.clone();
            let opened = tauri::async_runtime::spawn_blocking(move || {
                if std::fs::create_dir_all(&log_dir).is_err() {
                    return None;
                }
                std::fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(log_dir.join(&f_name))
                    .ok()
            })
            .await
            .ok()
            .flatten();
            if let Some(f) = opened {
                // 专用写盘线程：把阻塞的文件 IO 完全挪出 tokio worker。
                //
                // 原实现在这里直接 `w.write_all(data)`，也就是**每收到一个 SSH
                // 数据块就做一次可能落盘的系统调用**，而且发生在负责转发终端输出的
                // 那条异步任务上。`cat 大文件`、`tail -f`、`yes` 这类场景下每秒
                // 上千块，一旦日志目录在网络盘或磁盘繁忙，整个 runtime worker
                // 都会被卡住，表现为所有会话的输入与输出一起顿住。
                let header = format!(
                    "# === 会话日志 {host} [{session_id}] 开始于 {} ===\n",
                    now_str()
                );
                // 有界通道：写盘跟不上高速输出时丢弃最旧的日志块，
                // 而不是把内存吃光或反过来卡住终端转发。
                let (tx, rx) = std::sync::mpsc::sync_channel::<Vec<u8>>(64);
                let log_sid = session_id.clone();
                std::thread::Builder::new()
                    .name(format!("myterm-log-{log_sid}"))
                    .spawn(move || {
                        let mut w = std::io::BufWriter::with_capacity(64 * 1024, f);
                        let _ = w.write_all(header.as_bytes());
                        let _ = w.flush();
                        // 收到 None（发送端 drop）即会话结束，必须 flush 尾巴
                        while let Ok(chunk) = rx.recv() {
                            if w.write_all(&chunk).is_err() {
                                eprintln!("[log-{log_sid}] 写入失败，停止该会话日志");
                                break;
                            }
                        }
                        let tail = format!("\n# === 会话日志结束于 {} ===\n", now_str());
                        let _ = w.write_all(tail.as_bytes());
                        let _ = w.flush();
                    })
                    .ok();
                log_tx = Some(tx);
            }
        }

        loop {
            tokio::select! {
                msg = read_half.wait() => {
                    match msg {
                        Some(russh::ChannelMsg::Data { data }) => {
                            // 追加到缓冲；若超过上限，丢弃最旧数据，保留最新输出
                            data_buf.extend_from_slice(data.as_ref());
                            if data_buf.len() > DATA_BUF_CAP {
                                let excess = data_buf.len() - DATA_BUF_CAP;
                                data_buf.drain(..excess);
                            }
                            // 会话日志：写入原始输出（verbatim 转写）。
                            // 只做一次非阻塞投递，真正的落盘在专用线程里进行。
                            // 通道满说明写盘跟不上高速输出，此时丢弃本块日志
                            // （终端输出本身不受影响）—— 这是有意的取舍。
                            if let Some(tx) = log_tx.as_ref() {
                                let _ = tx.try_send(data.as_ref().to_vec());
                            }
                            // AI 上下文环形缓冲：保留最近 128KB 输出
                            {
                                let mut ring = output_ring.lock().await;
                                ring.extend_from_slice(data.as_ref());
                                const RING_CAP: usize = 128 * 1024;
                                if ring.len() > RING_CAP {
                                    let mut excess = ring.len() - RING_CAP;
                                    // 避免从多字节 UTF-8 字符中间截断（当前字节为续字节 10xxxxxx 时前移）
                                    while excess < ring.len()
                                        && (ring[excess] & 0xC0) == 0x80
                                    {
                                        excess -= 1;
                                    }
                                    ring.drain(..excess);
                                }
                            }
                            // 达到阈值立即刷新，保证吞吐
                            if data_buf.len() >= DATA_BUF_FLUSH_AT {
                                flush_data_buf(&out, &mut data_buf);
                            }
                        }
                        Some(russh::ChannelMsg::Eof) => {
                            // 通道结束前把剩余缓冲发送出去，避免丢数据
                            flush_data_buf(&out, &mut data_buf);
                            let _ = out.send(TerminalEvent::Close {
                                reason: CloseReason::Eof,
                            });
                            break;
                        }
                        Some(russh::ChannelMsg::Close) => {
                            flush_data_buf(&out, &mut data_buf);
                            let _ = out.send(TerminalEvent::Close {
                                reason: CloseReason::Close,
                            });
                            break;
                        }
                        Some(_) => {}
                        None => {
                            flush_data_buf(&out, &mut data_buf);
                            let _ = out.send(TerminalEvent::Close {
                                reason: CloseReason::Drop,
                            });
                            break;
                        }
                    }
                }
                _ = flush_timer.tick() => {
                    // 定时刷新：合并小块输出，降低消息频率
                    flush_data_buf(&out, &mut data_buf);
                }
                cmd = cmd_rx.recv() => {
                    match cmd {
                        Some(SessionCmd::Input(data)) => {
                            // 远端被 TCP 流量控制 / 服务器停止读取时，data_bytes 可能无限阻塞。
                            // 加超时防止后台任务卡死导致会话无法关闭。
                            // 结果不能丢弃：静默失败会让用户对着一个"看起来已连接、
                            // 实际已写不进去"的终端反复敲字而无任何提示。
                            if let Err(e) = tokio::time::timeout(
                                WRITE_TIMEOUT,
                                write_half.data_bytes(data),
                            )
                            .await
                            {
                                eprintln!("[session-{session_id}] 写入终端数据失败：{e:?}");
                                let _ = out.send(TerminalEvent::Error(format!(
                                    "发送输入失败（{WRITE_TIMEOUT:?}）：远端可能已停止读取数据"
                                )));
                                break;
                            }
                        }
                        Some(SessionCmd::Resize(cols, rows)) => {
                            if let Err(e) = tokio::time::timeout(
                                WRITE_TIMEOUT,
                                write_half.window_change(cols, rows, 0, 0),
                            )
                            .await
                            {
                                // 尺寸同步失败不致命：远端可能只是暂时拥塞，
                                // 仅告警并继续，保持会话可用。
                                eprintln!("[session-{session_id}] 同步终端尺寸失败：{e:?}");
                            }
                        }
                        Some(SessionCmd::Shutdown) | None => break,
                    }
                }
            }
        }
        // 任务退出时清空并发送剩余缓冲，随后清理会话
        flush_data_buf(&out, &mut data_buf);
        // 结束日志：drop 发送端 → 写盘线程的 recv() 返回 None → 补尾行并 flush。
        // 写盘是阻塞的，但这里不 join：会话收尾路径上没必要等磁盘。
        drop(log_tx.take());
        // 所有权校验：只有当表中登记的仍是**本任务**创建的连接时才清理。
        // 否则一次重连（旧的先退出、新的后写入）会让旧任务把新会话连同它的
        // 端口转发和监控一起误删。
        let state = app.state::<AppState>();
        let is_owner = state.sessions.lock().await.get(&session_id).is_some_and(|cur| cur.gen == gen);
        if is_owner {
            state.sessions.lock().await.remove(&session_id);
            // 清理该会话的本地端口转发（中止监听任务并释放本地端口）
            cleanup_session_forwards(&state, &session_id).await;
            // 停止远程监控
            let mut cancels = state.monitor_cancels.lock().await;
            if let Some(tx) = cancels.remove(&session_id) {
                let _ = tx.send(true);
            }
            // 异常断开（网络中断 / 远端重启 / 输入 exit）也要回收集群缓存。
            // 此前只有 disconnect_ssh 走这条清理，突发断开会残留
            // 状态缓存、端口探针、WebHDFS 端点与 HDFS 目录缓存，长期运行持续增长。
            state.cluster.cleanup_session(&session_id).await;
        } else {
            eprintln!(
                "[session-{session_id}] 会话已被新连接接管，跳过旧任务的清理以免误删新会话"
            );
        }
    });
}

/// 向前端会话发送终端输入（base64 编码，避免二进制数据经 JSON 传输的转义问题）
#[tauri::command]
pub async fn send_input(
    state: State<'_, AppState>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    use base64::engine::general_purpose::STANDARD as B64;
    use base64::Engine as _;

    let bytes = B64.decode(data).map_err(|e| format!("数据解码失败：{e}"))?;
    // 仅克隆 Sender 随即释放全局 sessions 锁，避免在锁内跨 await。
    // 若通道已满（后端写入慢），send().await 会阻塞，但此时不再持有锁，
    // 不会阻塞其它会话的输入 / resize / SFTP / 监控等命令。
    let cmd_tx = {
        let sessions = state.sessions.lock().await;
        sessions
            .get(&session_id)
            .ok_or_else(|| "会话不存在或已断开".to_string())?
            .cmd_tx
            .clone()
    };
    cmd_tx
        .send(SessionCmd::Input(bytes))
        .await
        .map_err(|_| "会话已断开".to_string())
}

/// 通知远端终端窗口尺寸变化
#[tauri::command]
pub async fn resize_pty(
    state: State<'_, AppState>,
    session_id: String,
    cols: u32,
    rows: u32,
) -> Result<(), String> {
    let cmd_tx = {
        let sessions = state.sessions.lock().await;
        sessions
            .get(&session_id)
            .ok_or_else(|| "会话不存在或已断开".to_string())?
            .cmd_tx
            .clone()
    };
    cmd_tx
        .send(SessionCmd::Resize(cols, rows))
        .await
        .map_err(|_| "会话已断开".to_string())
}

/// 主动断开指定会话
#[tauri::command]
pub async fn disconnect_ssh(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    let conn = { state.sessions.lock().await.remove(&session_id) };
    if let Some(conn) = conn {
        let _ = conn.cmd_tx.send(SessionCmd::Shutdown).await;
        let handle = conn.handle.lock().await;
        let _ = handle
            .disconnect(russh::Disconnect::ByApplication, "用户主动断开连接", "en")
            .await;
    }
    // 停止远程监控
    system::stop_session_monitor(&state, &session_id).await;
    // 清理该会话的本地端口转发
    cleanup_session_forwards(&state, &session_id).await;
    // 清理该会话的集群缓存（状态/端口/WebHDFS 探针/HDFS 目录缓存），
    // 防止长期运行内存缓慢增长
    state.cluster.cleanup_session(&session_id).await;
    Ok(())
}

/// 会话摘要（前端标签栏 / 侧边栏展示）
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    id: String,
    host: String,
    port: u16,
    username: String,
    status: SessionStatus,
}

/// 列出所有活动会话
#[tauri::command]
pub async fn list_sessions(state: State<'_, AppState>) -> Result<Vec<SessionSummary>, String> {
    let sessions = state.sessions.lock().await;
    Ok(sessions
        .values()
        .map(|c| SessionSummary {
            id: c.id.clone(),
            host: c.host.clone(),
            port: c.port,
            username: c.username.clone(),
            status: c.status.clone(),
        })
        .collect())
}

/// 把任意字符串收敛为可安全用作单个文件名的片段。
///
/// 允许字母数字与 `-_.`，其余一律替换为 `_`；空串退化为 "session"。
/// 用于日志文件名，避免 host / session_id 中的路径分隔符或 `..` 越出日志目录。
fn sanitize_path_component(raw: &str) -> String {
    let cleaned: String = raw
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.') {
                c
            } else {
                '_'
            }
        })
        .collect();
    let trimmed = cleaned.trim_matches('.').to_string();
    if trimmed.is_empty() {
        "session".to_string()
    } else {
        // 仍可能出现 ".." 之类的极端组合，再兜一层
        if trimmed.chars().all(|c| c == '.') {
            "session".to_string()
        } else {
            trimmed
        }
    }
}

/// 当前本地时间字符串（用于会话日志时间戳）
fn now_str() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    let secs = now % 60;
    let mins = (now / 60) % 60;
    let hours = (now / 3600) % 24;
    format!("{hours:02}:{mins:02}:{secs:02}")
}

/// 清理某会话的全部本地端口转发：中止监听任务并释放本地端口
pub async fn cleanup_session_forwards(state: &AppState, session_id: &str) {
    let tasks: Vec<ForwardEntry> = {
        let mut forwards = state.forwards.lock().await;
        match forwards.remove(session_id) {
            Some(map) => map.into_values().map(|e| e).collect::<Vec<_>>(),
            None => Vec::new(),
        }
    };
    for e in tasks {
        // 先发取消信号让监听循环走正常的退出分支，再 abort 兜底。
        let _ = e.cancel.send(true);
        e.task.abort();
        // 中继是独立任务，不随监听任务一起死，必须一并中止，
        // 否则本地 socket 与远端通道会一直挂到对端关闭为止
        e.relays.lock().await.abort_all();
    }
}

/// 打开转发通道的超时时间：必须存在，否则 Handle 锁可能被永久持有
const FORWARD_OPEN_TIMEOUT: Duration = Duration::from_secs(15);

/// 单个转发允许的最大并发连接数（每条都占用一条真实 SSH 通道）
const MAX_FORWARD_CONNS: usize = 32;

/// 单个连接的转发中继：在本地 socket 与远端直接 TCP 通道间双向拷贝
async fn relay_conn(
    handle: Arc<tokio::sync::Mutex<russh::client::Handle<Client>>>,
    socket: tokio::net::TcpStream,
    remote_host: String,
    remote_port: u16,
    peer: SocketAddr,
) -> Result<(), String> {
    // `Handle` 被全局 SFTP / 监控 / 转发共享，锁必须带超时释放：
// russh 的 channel_open_direct_tcpip 会等服务端应答且**没有内部超时**，
// 服务端收下通道却不回包时锁会被永久持有，该会话的其它所有操作随之全部卡死。
    let channel = tokio::time::timeout(
        FORWARD_OPEN_TIMEOUT,
        async {
            let h = handle.lock().await;
            h.channel_open_direct_tcpip(
                remote_host.clone(),
                remote_port as u32,
                peer.ip().to_string(),
                peer.port() as u32,
            )
            .await
        },
    )
    .await
    .map_err(|_| format!("打开到 {remote_host}:{remote_port} 的转发通道超时"))?
    .map_err(|e| format!("打开到 {remote_host}:{remote_port} 的转发通道失败：{e}"))?;
    let mut stream = channel.into_stream();
    let mut socket = socket;
    // 双向透传直到任一端关闭。错误不静默：转发中途断开时留一行日志，
    // 否则"已删除的转发"与"死掉的转发"在界面上完全无法区分。
    if let Err(e) = tokio::io::copy_bidirectional(&mut stream, &mut socket).await {
        eprintln!("[forward] {peer} 双向转发结束（{e}）");
    }
    Ok(())
}

/// 本地端口转发主循环：监听本地端口，每个连接建立一条到远端的直接 TCP 通道
async fn run_local_forward(
    handle: Arc<tokio::sync::Mutex<russh::client::Handle<Client>>>,
    listener: tokio::net::TcpListener,
    remote_host: String,
    remote_port: u16,
    mut cancel: tokio::sync::watch::Receiver<bool>,
    relays: Arc<tokio::sync::Mutex<tokio::task::JoinSet<()>>>,
    conn_sem: Arc<tokio::sync::Semaphore>,
) {
    loop {
        tokio::select! {
            _ = cancel.changed() => {
                // `Err` = 所有 Sender 已消失。再往下读到的只会是初始值 false，
                // 不 break 就会退化成忙等（见 ForwardEntry::cancel 的说明）。
                if cancel.changed().await.is_err() || *cancel.borrow() { break; }
            }
            accepted = listener.accept() => {
                match accepted {
                    Ok((socket, peer)) => {
                        // 限制并发中继数：否则本机任意进程都能在瞬间占满
                        // 服务器的 channel 配额（每条都真实占用一条 SSH 通道）。
                        let Ok(permit) = conn_sem.clone().try_acquire_owned() else {
                            eprintln!(
                                "[forward] 达到并发上限（{MAX_FORWARD_CONNS}），拒绝来自 {peer} 的连接"
                            );
                            drop(socket);
                            continue;
                        };
                        let h = handle.clone();
                        let rh = remote_host.clone();
                        relays.lock().await.spawn(async move {
                            let _permit = permit; // 释放即归还名额
                            if let Err(e) = relay_conn(h, socket, rh, remote_port, peer).await {
                                eprintln!("[forward] {peer} 中继失败：{e}");
                            }
                        });
                    }
                    Err(_) => {
                        tokio::time::sleep(Duration::from_millis(50)).await;
                    }
                }
            }
        }
    }
}

/// 新增本地端口转发：本地端口 → 经该会话隧道 → 远端目标
#[tauri::command]
pub async fn forward_add(
    state: State<'_, AppState>,
    session_id: String,
    local_port: u16,
    remote_host: String,
    remote_port: u16,
) -> Result<ForwardInfo, String> {
    let (handle, host) = {
        let sessions = state.sessions.lock().await;
        let conn = sessions
            .get(&session_id)
            .ok_or_else(|| "会话不存在或已断开".to_string())?;
        (conn.handle.clone(), conn.host.clone())
    };

    let listener = tokio::net::TcpListener::bind(("127.0.0.1", local_port))
        .await
        .map_err(|e| format!("无法监听本地端口 {local_port}：{e}"))?;
    let actual_port = listener
        .local_addr()
        .map_err(|e| format!("获取本地端口失败：{e}"))?
        .port();

    // 端口冲突检查（占用检查在绑定之后、任务启动之前，避免并发重复绑定）
    {
        let mut forwards = state.forwards.lock().await;
        let per = forwards.entry(session_id.clone()).or_default();
        if per.contains_key(&actual_port) {
            return Err(format!("本地端口 {actual_port} 已存在转发"));
        }
        let info = ForwardInfo {
            session_id: session_id.clone(),
            host: host.clone(),
            local_port: actual_port,
            remote_host: remote_host.clone(),
            remote_port,
        };
        let (cancel_tx, cancel_rx) = tokio::sync::watch::channel(false);
        let h = handle.clone();
        let rh = remote_host.clone();
        let relays: std::sync::Arc<tokio::sync::Mutex<tokio::task::JoinSet<()>>> =
            std::sync::Arc::new(tokio::sync::Mutex::new(tokio::task::JoinSet::new()));
        let conn_sem = std::sync::Arc::new(tokio::sync::Semaphore::new(MAX_FORWARD_CONNS));
        let r = relays.clone();
        let sem = conn_sem.clone();
        let task = tauri::async_runtime::spawn(async move {
            run_local_forward(h, listener, rh, remote_port, cancel_rx, r, sem).await;
        });
        // 关键：cancel_tx 必须随 entry 一起保存，绝不能就地 drop。
        // drop 掉它会让接收端 changed() 永久返回 Err，监听循环变成 CPU 忙等。
        per.insert(
            actual_port,
            ForwardEntry {
                info: info.clone(),
                task,
                cancel: cancel_tx,
                relays,
            },
        );
        Ok(info)
    }
}

/// 列出所有活动的本地端口转发
#[tauri::command]
pub async fn forward_list(state: State<'_, AppState>) -> Result<Vec<ForwardInfo>, String> {
    let forwards = state.forwards.lock().await;
    let mut out = Vec::new();
    for map in forwards.values() {
        for entry in map.values() {
            out.push(entry.info.clone());
        }
    }
    Ok(out)
}

/// 移除一个本地端口转发
#[tauri::command]
pub async fn forward_remove(
    state: State<'_, AppState>,
    session_id: String,
    local_port: u16,
) -> Result<(), String> {
    let entry = {
        let mut forwards = state.forwards.lock().await;
        let removed = forwards
            .get_mut(&session_id)
            .and_then(|map| map.remove(&local_port));
        // 顺带清掉空的内层 map：否则每次移除一个转发都会给该会话留下一个空条目，
        // 长连接会话上反复增删会让外层 map 缓慢膨胀（只有会话结束才会被整体回收）。
        if let Some(map) = forwards.get(&session_id) {
            if map.is_empty() {
                forwards.remove(&session_id);
            }
        }
        removed
    };
    match entry {
        Some(e) => {
            let _ = e.cancel.send(true);
            e.task.abort();
            // 中继子任务独立于监听任务，必须一并中止
            e.relays.lock().await.abort_all();
            Ok(())
        }
        None => Err("转发不存在或已停止".to_string()),
    }
}

/// 去除终端输出中的 ANSI 转义序列（颜色 / 光标 / OSC 等），用于 AI 上下文分析
/// 保留字符串尾部 `max` 个**字符**（不是字节）。
///
/// 终端输出以中文为主，一个字占 3 字节，用字节口径做上限会让实际内容
/// 与调用方声明的字符数差 3 倍。
fn truncate_tail_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    s.chars()
        .rev()
        .take(max)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect()
}

fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            // OSC: ESC ] ... BEL 或 ST
            if chars.peek() == Some(&']') {
                chars.next();
                for c2 in chars.by_ref() {
                    if c2 == '\u{0007}' {
                        break;
                    }
                    if c2 == '\u{1b}' {
                        if chars.peek() == Some(&'\\') {
                            chars.next();
                        }
                        break;
                    }
                }
                continue;
            }
            // CSI: ESC [ ... 最终字节 0x40-0x7E
            if chars.peek() == Some(&'[') {
                chars.next();
                for c2 in chars.by_ref() {
                    if ('\u{40}'..='\u{7e}').contains(&c2) {
                        break;
                    }
                }
                continue;
            }
            // 单字符转义
            continue;
        }
        out.push(c);
    }
    out
}

/// 取回某会话最近一段终端输出（去除 ANSI，保留最近 max_chars 字符），
/// 供 AI 助手分析报错 / 生成命令 / 引用上下文使用。max_chars 为 0 时默认 16000。
#[tauri::command]
pub async fn session_recent_output(
    state: State<'_, AppState>,
    session_id: String,
    max_chars: usize,
) -> Result<String, String> {
    let ring = {
        let sessions = state.sessions.lock().await;
        match sessions.get(&session_id) {
            Some(c) => c.output_ring.clone(),
            None => return Err("会话不存在或已断开".to_string()),
        }
    };
    let bytes = ring.lock().await.clone();
    let mut text = strip_ansi(&String::from_utf8_lossy(&bytes));
    let max = if max_chars == 0 { 16000 } else { max_chars };
    // text.len() 是**字节数**而 max 的语义是字符数：直接比较会让中文场景下
    // 判断依据与实际截断量差 3 倍（且 ASCII 时反而偏小）。
    text = truncate_tail_chars(&text, max);
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_rejects_path_traversal() {
        // 绝不能产生能逃出日志目录的分量
        assert_eq!(sanitize_path_component("../../etc/passwd"), "_.._etc_passwd");
        assert_eq!(sanitize_path_component(r"..\..\evil"), "_.._evil");
        assert_eq!(sanitize_path_component("a/b"), "a_b");
        assert_eq!(sanitize_path_component(r"a\b"), "a_b");
        assert_eq!(sanitize_path_component(".."), "session");
        assert_eq!(sanitize_path_component(""), "session");
        assert_eq!(sanitize_path_component("..."), "session");
    }

    #[test]
    fn sanitize_keeps_readable_names() {
        assert_eq!(sanitize_path_component("10.0.0.5"), "10.0.0.5");
        assert_eq!(sanitize_path_component("web-01_prod"), "web-01_prod");
        assert_eq!(sanitize_path_component("sess-abc123"), "sess-abc123");
    }

    #[test]
    fn sanitize_output_never_contains_separators() {
        for raw in ["../../x", r"..\..\x", "a/b/c", "a\\b\\c", "..", "///", ":C:"] {
            let out = sanitize_path_component(raw);
            assert!(!out.contains('/'), "{raw} -> {out}");
            assert!(!out.contains('\\'), "{raw} -> {out}");
            assert!(!out.is_empty());
        }
    }

    #[test]
    fn parses_known_hosts() {
        let text = "# comment\n\nhost1:22 SHA256:aaa\nhost2:2222 SHA256:bbb\njunk\n";
        let map = parse_known_hosts(text);
        assert_eq!(map.get("host1:22").map(String::as_str), Some("SHA256:aaa"));
        assert_eq!(map.get("host2:2222").map(String::as_str), Some("SHA256:bbb"));
        assert_eq!(map.len(), 2);
    }

    #[test]
    fn strip_ansi_removes_sequences() {
        assert_eq!(strip_ansi("\u{1b}[31mred\u{1b}[0m"), "red");
        assert_eq!(strip_ansi("\u{1b}]0;title\u{7}text"), "text");
        assert_eq!(strip_ansi("plain"), "plain");
    }

    #[test]
    fn recent_output_truncation_is_char_based() {
        // max_chars 语义是"字符数"，中文占 3 字节
        let s = "中文测试内容";
        // 保留的是**尾部**（最近的输出），不是头部
        assert_eq!(truncate_tail_chars(s, 4), "测试内容");
        assert_eq!(truncate_tail_chars(s, 99), "中文测试内容");
        assert_eq!(truncate_tail_chars(s, 0), "");
    }
}
