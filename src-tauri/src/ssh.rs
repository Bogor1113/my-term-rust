//! SSH 模块：基于 russh 的远程终端连接管理
//!
//! 架构：每个连接由「会话处理器（Handle）」+「后台任务」组成。
//! - `Handle` 存放在全局状态中，供 SFTP 等操作复用同一个已认证连接；
//! - 后台任务持有 shell 通道的读写半部，负责把服务器输出流式转发给前端，
//!   并消费前端通过 Tauri 命令发来的输入 / 调整尺寸 / 断开指令。

use std::io::Write;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use tauri::{AppHandle, Manager, State};

use crate::{system, AppState};

/// SSH 客户端处理器。
///
/// 出于简洁与易用，这里接受所有服务器主机密钥（不校验 known_hosts）。
/// 生产环境中建议实现 Trust-On-First-Use 或显式的指纹校验。
#[derive(Clone)]
pub struct Client;

impl russh::client::Handler for Client {
    type Error = russh::Error;

    async fn check_server_key(&mut self, _key: &ssh_key::PublicKey) -> Result<bool, Self::Error> {
        Ok(true)
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
}

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

    let mut handle = tokio::time::timeout(
        Duration::from_secs(15),
        russh::client::connect(config, (host.as_str(), port), Client {}),
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
    };
    state.sessions.lock().await.insert(session_id.clone(), conn);

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
        let mut log_writer: Option<std::io::BufWriter<std::fs::File>> = None;
        if log_cfg.enabled && !log_cfg.dir.as_os_str().is_empty() {
            if std::fs::create_dir_all(&log_cfg.dir).is_ok() {
                let file_name = format!("{host}_{session_id}.log");
                let path = log_cfg.dir.join(&file_name);
                if let Ok(f) = std::fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(&path)
                {
                    let mut w = std::io::BufWriter::new(f);
                    let header = format!(
                        "# === 会话日志 {host} [{session_id}] 开始于 {} ===\n",
                        now_str()
                    );
                    let _ = w.write_all(header.as_bytes());
                    let _ = w.flush();
                    log_writer = Some(w);
                }
            }
        }

        loop {
            tokio::select! {
                msg = read_half.wait() => {
                    match msg {
                        Some(russh::ChannelMsg::Data { data }) => {
                            // 追加到缓冲；若超过上限，丢弃最旧数据，保留最新输出
                            data_buf.extend_from_slice(data.as_ref());
                            // 会话日志：写入原始输出（verbatim 转写）。
                            // 这里刻意不 flush：原始实现每个 SSH 数据块都 flush 一次，
                            // 等于把 BufWriter 彻底废掉（每块一次 write 系统调用，
                            // cat 大文件 / tail -f 场景下每秒成千上万次）。
                            // BufWriter 在缓冲写满时自动落盘，会话结束（任务退出、
                            // writer 被 drop）时也必然 flush，丢失窗口仅限进程崩溃。
                            if let Some(w) = log_writer.as_mut() {
                                let _ = w.write_all(data.as_ref());
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
                            if data_buf.len() > DATA_BUF_CAP {
                                let excess = data_buf.len() - DATA_BUF_CAP;
                                data_buf.drain(..excess);
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
                            let _ = tokio::time::timeout(
                                WRITE_TIMEOUT,
                                write_half.data_bytes(data),
                            )
                            .await;
                        }
                        Some(SessionCmd::Resize(cols, rows)) => {
                            let _ = tokio::time::timeout(
                                WRITE_TIMEOUT,
                                write_half.window_change(cols, rows, 0, 0),
                            )
                            .await;
                        }
                        Some(SessionCmd::Shutdown) | None => break,
                    }
                }
            }
        }
        // 任务退出时清空并发送剩余缓冲，随后清理会话
        flush_data_buf(&out, &mut data_buf);
        // 刷新日志尾部并关闭文件
        if let Some(mut w) = log_writer.take() {
            let tail = format!("\n# === 会话日志结束于 {} ===\n", now_str());
            let _ = w.write_all(tail.as_bytes());
            let _ = w.flush();
        }
        let state = app.state::<AppState>();
        state.sessions.lock().await.remove(&session_id);
        // 清理该会话的本地端口转发（中止监听任务并释放本地端口）
        cleanup_session_forwards(&state, &session_id).await;
        // 停止远程监控
        let mut cancels = state.monitor_cancels.lock().await;
        if let Some(tx) = cancels.remove(&session_id) {
            let _ = tx.send(true);
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
    let tasks: Vec<tauri::async_runtime::JoinHandle<()>> = {
        let mut forwards = state.forwards.lock().await;
        match forwards.remove(session_id) {
            Some(map) => map.into_values().map(|e| e.task).collect(),
            None => Vec::new(),
        }
    };
    for t in tasks {
        t.abort();
    }
}

/// 单个连接的转发中继：在本地 socket 与远端直接 TCP 通道间双向拷贝
async fn relay_conn(
    handle: Arc<tokio::sync::Mutex<russh::client::Handle<Client>>>,
    socket: tokio::net::TcpStream,
    remote_host: String,
    remote_port: u16,
    peer: SocketAddr,
) -> Result<(), String> {
    let channel = {
        let h = handle.lock().await;
        h.channel_open_direct_tcpip(
            remote_host.clone(),
            remote_port as u32,
            peer.ip().to_string(),
            peer.port() as u32,
        )
        .await
        .map_err(|e| format!("打开到 {remote_host}:{remote_port} 的转发通道失败：{e}"))?
    };
    let mut stream = channel.into_stream();
    let mut socket = socket;
    // 双向透传直到任一端关闭
    let _ = tokio::io::copy_bidirectional(&mut stream, &mut socket).await;
    Ok(())
}

/// 本地端口转发主循环：监听本地端口，每个连接建立一条到远端的直接 TCP 通道
async fn run_local_forward(
    handle: Arc<tokio::sync::Mutex<russh::client::Handle<Client>>>,
    listener: tokio::net::TcpListener,
    remote_host: String,
    remote_port: u16,
    mut cancel: tokio::sync::watch::Receiver<bool>,
) {
    loop {
        tokio::select! {
            _ = cancel.changed() => {
                if *cancel.borrow() { break; }
            }
            accepted = listener.accept() => {
                match accepted {
                    Ok((socket, peer)) => {
                        let h = handle.clone();
                        let rh = remote_host.clone();
                        tauri::async_runtime::spawn(async move {
                            let _ = relay_conn(h, socket, rh, remote_port, peer).await;
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
        let task = tauri::async_runtime::spawn(async move {
            run_local_forward(h, listener, rh, remote_port, cancel_rx).await;
        });
        per.insert(actual_port, ForwardEntry { info: info.clone(), task });
        // 保存取消信号，供后续可能的中止（此处未用，保留 API）
        let _ = cancel_tx;
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
    let task = {
        let mut forwards = state.forwards.lock().await;
        match forwards.get_mut(&session_id) {
            Some(map) => map.remove(&local_port).map(|e| e.task),
            None => None,
        }
    };
    match task {
        Some(t) => {
            t.abort();
            Ok(())
        }
        None => Err("转发不存在或已停止".to_string()),
    }
}

/// 去除终端输出中的 ANSI 转义序列（颜色 / 光标 / OSC 等），用于 AI 上下文分析
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
    if text.len() > max {
        text = text
            .chars()
            .rev()
            .take(max)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
    }
    Ok(text)
}
