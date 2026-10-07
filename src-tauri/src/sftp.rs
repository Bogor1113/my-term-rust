//! SFTP 模块：基于 russh-sftp 的远程文件管理
//!
//! 每个操作都会在已认证的会话上临时打开一个独立的 SFTP 子系统通道，
//! 与终端 shell 通道复用同一条 SSH 连接（russh 支持多通道多路复用），
//! 互不阻塞。

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use tauri::State;

use russh_sftp::client::SftpSession;
use crate::AppState;

/// 目录列表最大条目数：防止超大目录（百万级）导致 OOM 与前端渲染卡死
const MAX_DIR_ENTRIES: usize = 10_000;

/// 递归收集 / 删除的条目数上限：防止超大目录（Hadoop 场景常见百万级小文件）
/// 在收集阶段就把全部路径拉进内存导致 OOM，超过则报错提示缩小范围
const MAX_COLLECT_FILES: usize = 50_000;

/// SFTP 单次读写操作超时：网络中断或服务器停止响应时，
/// 避免传输无限期阻塞导致前端进度条卡死（与 ssh.rs 的 WRITE_TIMEOUT 一致）
const SFTP_IO_TIMEOUT: Duration = Duration::from_secs(30);

/// 目录列表中的一项
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpEntry {
    name: String,
    path: String,
    is_dir: bool,
    size: u64,
    mtime: Option<u64>,
    perms: String,
}

/// 同名文件冲突信息
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictInfo {
    /// 冲突请求 ID（用于 sftp_resolve_conflict 回复）
    pub request_id: String,
    /// 冲突文件名
    pub name: String,
    /// 冲突目标完整路径
    pub path: String,
}

/// 传输进度事件（文件 / 目录通用）
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferProgress {
    /// 已传输字节数
    pub transferred: u64,
    /// 总字节数（目录传输为全部文件合计）
    pub total: u64,
    /// 百分比 0~100
    pub percent: f64,
    /// 当前正在传输的文件（目录传输时为相对路径，单文件为文件名）
    pub file: Option<String>,
    /// 已完成文件数
    pub files: u64,
    /// 总文件数
    pub total_files: u64,
    /// 因同名冲突而跳过的文件数
    pub skipped: u64,
    /// 存在同名冲突时非空，传输任务将挂起等待前端选择
    pub conflict: Option<ConflictInfo>,
}

/// 前端对单个冲突的处理选择
#[derive(Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConflictChoice {
    /// 仅本次覆盖
    Overwrite,
    /// 仅本次跳过
    Skip,
    /// 自动生成新文件名（如 name (1).ext）
    Rename,
    /// 本次传输剩余冲突全部覆盖
    OverwriteAll,
    /// 本次传输剩余冲突全部跳过
    SkipAll,
    /// 取消整个传输
    Cancel,
}

/// 本次传输当前的冲突处理模式
#[derive(Clone, Copy)]
enum ConflictMode {
    /// 每次冲突都询问前端
    Ask,
    /// 剩余冲突一律覆盖
    Overwrite,
    /// 剩余冲突一律跳过
    Skip,
}

/// 冲突请求自增序号
static CONFLICT_SEQ: AtomicU64 = AtomicU64::new(0);

/// 冲突挂起条目的清理守卫：无论正常返回还是任务被取消（命令 future 被 drop，
/// 例如关闭 SFTP 面板 / 切换标签导致 Tauri 调用中止），
/// 都会把对应 request_id 从全局 map 移除，防止残留 oneshot Sender 造成内存泄漏。
struct PendingConflictGuard<'a> {
    map: &'a tokio::sync::Mutex<HashMap<String, tokio::sync::oneshot::Sender<ConflictChoice>>>,
    request_id: Option<String>,
}

impl Drop for PendingConflictGuard<'_> {
    fn drop(&mut self) {
        if let Some(id) = self.request_id.take() {
            // 该锁在冲突处理中从不跨 await 持有（仅插入/移除/发送，均为瞬时操作），
            // 此处用 blocking_lock 是安全的，不会长时间阻塞。
            let mut map = self.map.blocking_lock();
            map.remove(&id);
        }
    }
}

/// 在指定会话上打开一个 SFTP 子系统通道
async fn open_sftp(
    state: &State<'_, AppState>,
    session_id: &str,
) -> Result<SftpSession, String> {
    // 仅快速克隆句柄 Arc 随即释放全局 sessions 锁，
    // 网络往返（打开通道 / 请求子系统 / 初始化）全部在锁外进行，
    // 避免阻塞其它会话的输入与命令。
    let handle_arc = {
        let sessions = state.sessions.lock().await;
        let conn = sessions
            .get(session_id)
            .ok_or_else(|| "会话不存在或已断开".to_string())?;
        conn.handle.clone()
    };

    let channel = {
        let handle = handle_arc.lock().await;
        let channel = handle
            .channel_open_session()
            .await
            .map_err(|e| format!("打开通道失败：{e}"))?;
        channel
            .request_subsystem(true, "sftp")
            .await
            .map_err(|e| format!("请求 SFTP 子系统失败：{e}"))?;
        channel
    };
    SftpSession::new(channel.into_stream())
        .await
        .map_err(|e| format!("初始化 SFTP 失败：{e}"))
}

/// 获取远程用户的 home 目录（SFTP 默认目录）
///
/// 优先通过 SFTP `canonicalize(".")` 获取；若服务器不支持该操作（如某些
/// 受限 SFTP 实现），则回退执行 SSH exec `echo $HOME` 获取环境变量。
#[tauri::command]
pub async fn sftp_home(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<String, String> {
    // 尝试 SFTP canonicalize（最可靠，不依赖 shell）
    let sftp = open_sftp(&state, &session_id).await?;
    match sftp.canonicalize(".").await {
        Ok(home) => return Ok(home),
        Err(_) => {
            // canonicalize 失败（如不支持该操作），继续尝试回退
        }
    }
    drop(sftp); // 关闭 SFTP 通道

    // 回退：通过 SSH exec 获取 HOME 环境变量
    use russh::ChannelMsg;
    let handle_arc = {
        let sessions = state.sessions.lock().await;
        let conn = sessions
            .get(&session_id)
            .ok_or_else(|| "会话不存在或已断开".to_string())?;
        conn.handle.clone()
    };
    let mut channel = {
        let handle = handle_arc.lock().await;
        let chan = handle
            .channel_open_session()
            .await
            .map_err(|e| format!("打开通道失败：{e}"))?;
        chan.exec(true, "echo $HOME".as_bytes())
            .await
            .map_err(|e| format!("执行命令失败：{e}"))?;
        chan
    };
    let mut output = Vec::new();
    loop {
        match channel.wait().await {
            Some(ChannelMsg::Data { data }) => {
                output.extend_from_slice(&data);
            }
            Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => break,
            Some(_) => {}
        }
    }
    let home = String::from_utf8_lossy(&output).trim().to_string();
    if home.is_empty() {
        return Err("无法获取 home 目录".to_string());
    }
    Ok(home)
}

/// 列出远程目录内容（目录在前，按名称排序）
#[tauri::command]
pub async fn sftp_list(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
) -> Result<Vec<SftpEntry>, String> {
    let sftp = open_sftp(&state, &session_id).await?;
    let read_dir = sftp
        .read_dir(&path)
        .await
        .map_err(|e| format!("读取目录失败：{e}"))?;

    let mut entries = Vec::new();
    for entry in read_dir {
        let name = entry.file_name();
        if name == "." || name == ".." {
            continue;
        }
        // 超出上限时截断，防止超大目录导致 OOM 与前端渲染卡死
        if entries.len() >= MAX_DIR_ENTRIES {
            eprintln!(
                "[sftp] 目录 {path} 条目数超过上限 {MAX_DIR_ENTRIES}，已截断"
            );
            break;
        }
        let meta = entry.metadata();
        let full = if path.ends_with('/') {
            format!("{path}{name}")
        } else {
            format!("{path}/{name}")
        };
        entries.push(SftpEntry {
            name,
            path: full,
            is_dir: meta.is_dir(),
            size: meta.len(),
            mtime: meta.mtime.map(|t| t as u64),
            perms: meta.permissions().to_string(),
        });
    }
    entries.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then(a.name.cmp(&b.name)));
    Ok(entries)
}

/// 创建远程目录
#[tauri::command]
pub async fn sftp_mkdir(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
) -> Result<(), String> {
    let sftp = open_sftp(&state, &session_id).await?;
    sftp.create_dir(&path)
        .await
        .map_err(|e| format!("创建目录失败：{e}"))
}

/// 重命名 / 移动远程文件或目录
#[tauri::command]
pub async fn sftp_rename(
    state: State<'_, AppState>,
    session_id: String,
    old_path: String,
    new_path: String,
) -> Result<(), String> {
    let sftp = open_sftp(&state, &session_id).await?;
    sftp.rename(&old_path, &new_path)
        .await
        .map_err(|e| format!("重命名失败：{e}"))
}

/// 递归删除远程目录及其全部内容（先删文件/符号链接，再自底向上删目录）
async fn remove_remote_recursive(
    sftp: &SftpSession,
    path: &str,
) -> Result<(), String> {
    // 第一遍：收集目录（顶层在前）与文件（含符号链接等，用 remove_file 删除）
    let mut dirs: Vec<String> = Vec::new();
    let mut files: Vec<String> = Vec::new();
    let mut queue = VecDeque::new();
    queue.push_back(String::new());
    while let Some(rel) = queue.pop_front() {
        let full = if rel.is_empty() {
            path.to_string()
        } else {
            format!("{path}/{rel}")
        };
        let entries = sftp
            .read_dir(&full)
            .await
            .map_err(|e| format!("读取目录失败：{e}"))?;
        for entry in entries {
            let name = entry.file_name();
            if name == "." || name == ".." {
                continue;
            }
            let child = if rel.is_empty() {
                name
            } else {
                format!("{rel}/{name}")
            };
            // 收集条目数上限保护：防止百万级目录把全部路径载入内存导致 OOM
            if dirs.len() + files.len() >= MAX_COLLECT_FILES {
                return Err(format!(
                    "该目录包含超过 {MAX_COLLECT_FILES} 个条目，为避免内存溢出已中止删除，请分批处理"
                ));
            }
            if entry.file_type().is_dir() {
                dirs.push(child.clone());
                queue.push_back(child);
            } else {
                files.push(child);
            }
        }
    }

    // 先删除所有文件
    for f in &files {
        sftp.remove_file(&format!("{path}/{f}"))
            .await
            .map_err(|e| format!("删除文件失败：{e}"))?;
    }
    // 从最深目录开始逐层删除
    for d in dirs.iter().rev() {
        sftp.remove_dir(&format!("{path}/{d}"))
            .await
            .map_err(|e| format!("删除目录失败：{e}"))?;
    }
    // 最后删除根目录
    sftp.remove_dir(path)
        .await
        .map_err(|e| format!("删除目录失败：{e}"))?;
    Ok(())
}

/// 删除远程文件或目录。
/// `recursive` 为 true 时目录会递归清空后删除；为 false 时目录必须为空。
#[tauri::command]
pub async fn sftp_remove(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
    recursive: bool,
) -> Result<(), String> {
    let sftp = open_sftp(&state, &session_id).await?;
    let meta = sftp
        .metadata(&path)
        .await
        .map_err(|e| format!("获取文件信息失败：{e}"))?;
    if meta.is_dir() {
        if recursive {
            remove_remote_recursive(&sftp, &path).await
        } else {
            sftp.remove_dir(&path)
                .await
                .map_err(|e| format!("删除目录失败：{e}（目录非空时请先清空内容）"))
        }
    } else {
        sftp.remove_file(&path)
            .await
            .map_err(|e| format!("删除文件失败：{e}"))
    }
}

// ================= 递归传输（文件 / 目录通用） =================

/// 递归收集本地目录结构（迭代式 DFS）。
/// `dirs` 为相对路径（父目录在前），`files` 为 (相对路径, 大小)。
/// 跳过符号链接与其它特殊类型，避免循环与意外传输。
async fn collect_local_tree(
    root: &Path,
    rel: &str,
    dirs: &mut Vec<String>,
    files: &mut Vec<(String, u64)>,
) -> Result<(), String> {
    let mut stack = Vec::new();
    stack.push(rel.to_string());
    while let Some(rel) = stack.pop() {
        let mut rd = tokio::fs::read_dir(root.join(&rel))
            .await
            .map_err(|e| format!("读取本地目录失败：{e}"))?;
        let mut children = Vec::new();
        while let Some(entry) = rd
            .next_entry()
            .await
            .map_err(|e| format!("读取本地目录失败：{e}"))?
        {
            let ft = entry
                .file_type()
                .await
                .map_err(|e| format!("读取本地文件信息失败：{e}"))?;
            if !ft.is_dir() && !ft.is_file() {
                continue; // 跳过符号链接 / 其它类型
            }
            let name = entry.file_name().to_string_lossy().to_string();
            let child = if rel.is_empty() {
                name
            } else {
                format!("{rel}/{name}")
            };
            // 文件数上限保护：防止超大目录全部载入内存导致 OOM
            if files.len() >= MAX_COLLECT_FILES {
                return Err(format!(
                    "该目录包含超过 {MAX_COLLECT_FILES} 个文件，请缩小范围后再试"
                ));
            }
            if ft.is_dir() {
                dirs.push(child.clone());
                children.push(child);
            } else {
                let len = entry
                    .metadata()
                    .await
                    .map_err(|e| format!("读取本地文件信息失败：{e}"))?
                    .len();
                files.push((child, len));
            }
        }
        for child in children.into_iter().rev() {
            stack.push(child);
        }
    }
    Ok(())
}

/// 递归收集远程目录结构（BFS）。
/// `dirs` 为相对路径（父目录在前），`files` 为 (相对路径, 大小)。
/// 跳过符号链接，避免循环。
async fn collect_remote_tree(
    sftp: &SftpSession,
    root: &str,
) -> Result<(Vec<String>, Vec<(String, u64)>), String> {
    let mut dirs = Vec::new();
    let mut files = Vec::new();
    let mut queue = VecDeque::new();
    queue.push_back(String::new());
    while let Some(rel) = queue.pop_front() {
        let full = if rel.is_empty() {
            root.to_string()
        } else {
            format!("{root}/{rel}")
        };
        let entries = sftp
            .read_dir(&full)
            .await
            .map_err(|e| format!("读取目录失败：{e}"))?;
        for entry in entries {
            let name = entry.file_name();
            if name == "." || name == ".." {
                continue;
            }
            let ft = entry.file_type();
            if ft.is_symlink() {
                continue; // 不跟随符号链接
            }
            let child = if rel.is_empty() {
                name
            } else {
                format!("{rel}/{name}")
            };
            // 文件数上限保护：防止超大目录全部载入内存导致 OOM
            if files.len() >= MAX_COLLECT_FILES {
                return Err(format!(
                    "该目录包含超过 {MAX_COLLECT_FILES} 个文件，请缩小范围后再试"
                ));
            }
            if ft.is_dir() {
                dirs.push(child.clone());
                queue.push_back(child);
            } else {
                files.push((child, entry.metadata().len()));
            }
        }
    }
    Ok((dirs, files))
}

/// 确保远程目录存在（不存在则创建；父目录必须已存在）
async fn ensure_remote_dir(sftp: &SftpSession, path: &str) -> Result<(), String> {
    match sftp.metadata(path).await {
        Ok(m) if m.is_dir() => Ok(()),
        Ok(_) => Err(format!("远程路径已存在且不是目录：{path}")),
        Err(_) => sftp
            .create_dir(path)
            .await
            .map_err(|e| format!("创建远程目录失败：{e}")),
    }
}

/// 生成不冲突的目标路径：`name (1).ext`、`name (2).ext`…
/// `remote` 为 Some 时用远程 SFTP 判断存在性，否则用本地文件系统。
async fn next_available_name(
    target: &str,
    remote: Option<&SftpSession>,
) -> Result<String, String> {
    let (dir, name) = match target.rfind(['/', '\\']) {
        Some(idx) if idx + 1 < target.len() => (
            target[..idx].to_string(),
            target[idx + 1..].to_string(),
        ),
        _ => (String::new(), target.to_string()),
    };
    let sep = if target.contains('\\') { '\\' } else { '/' };
    let (stem, ext) = match name.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() => (s.to_string(), format!(".{e}")),
        _ => (name, String::new()),
    };
    let mut i = 1u32;
    loop {
        // 上限保护：极端场景（同名变体极多）下避免无限循环与无谓的远程往返
        if i > 10_000 {
            return Err(format!(
                "无法为 {stem}{ext} 生成不冲突的文件名（已尝试 10000 次）"
            ));
        }
        let candidate = format!("{stem} ({i}){ext}");
        let full = if dir.is_empty() {
            candidate
        } else {
            format!("{dir}{sep}{candidate}")
        };
        let exists = match remote {
            Some(s) => s.metadata(&full).await.is_ok(),
            None => tokio::fs::metadata(&full).await.is_ok(),
        };
        if !exists {
            return Ok(full);
        }
        i += 1;
    }
}

/// 处理单个文件目标的同名冲突，返回 (是否跳过, 实际使用路径)。
/// 处于 Ask 模式时向前端发送冲突事件并等待选择（超时 60s 按跳过处理）。
#[allow(clippy::too_many_arguments)]
async fn handle_conflict(
    state: &AppState,
    target: &str,
    exists: bool,
    mode: &mut ConflictMode,
    on_progress: &tauri::ipc::Channel<TransferProgress>,
    remote: Option<&SftpSession>,
    transferred: u64,
    total: u64,
    files_done: u64,
    total_files: u64,
    skipped: &mut u64,
) -> Result<(bool, String), String> {
    if !exists {
        return Ok((false, target.to_string()));
    }
    match *mode {
        ConflictMode::Overwrite => Ok((false, target.to_string())),
        ConflictMode::Skip => {
            *skipped += 1;
            Ok((true, target.to_string()))
        }
        ConflictMode::Ask => {
            let request_id = format!("c-{}", CONFLICT_SEQ.fetch_add(1, Ordering::Relaxed));
            let (tx, rx) = tokio::sync::oneshot::channel();
            let mut guard = PendingConflictGuard {
                map: &state.conflict_resolvers,
                request_id: Some(request_id.clone()),
            };
            state
                .conflict_resolvers
                .lock()
                .await
                .insert(request_id.clone(), tx);
            let name = target
                .rsplit(['/', '\\'])
                .next()
                .unwrap_or(target)
                .to_string();
            let _ = on_progress.send(TransferProgress {
                transferred,
                total,
                percent: if total > 0 {
                    transferred as f64 / total as f64 * 100.0
                } else {
                    100.0
                },
                file: Some(name.clone()),
                files: files_done,
                total_files,
                skipped: *skipped,
                conflict: Some(ConflictInfo {
                    request_id: request_id.clone(),
                    name,
                    path: target.to_string(),
                }),
            });
            // 等待期间若 future 被取消（传输中止），guard 的 Drop 会自动清理条目；
            // 正常结束后显式移除并解除 guard，避免重复操作
            let choice = match tokio::time::timeout(Duration::from_secs(60), rx).await {
                Ok(Ok(c)) => c,
                _ => ConflictChoice::Skip, // 超时 / 通道断开 → 跳过
            };
            state.conflict_resolvers.lock().await.remove(&request_id);
            guard.request_id = None;
            match choice {
                ConflictChoice::Overwrite => Ok((false, target.to_string())),
                ConflictChoice::Skip => {
                    *skipped += 1;
                    Ok((true, target.to_string()))
                }
                ConflictChoice::Rename => {
                    let new_path = next_available_name(target, remote).await?;
                    Ok((false, new_path))
                }
                ConflictChoice::OverwriteAll => {
                    *mode = ConflictMode::Overwrite;
                    Ok((false, target.to_string()))
                }
                ConflictChoice::SkipAll => {
                    *mode = ConflictMode::Skip;
                    *skipped += 1;
                    Ok((true, target.to_string()))
                }
                ConflictChoice::Cancel => Err("传输已取消".to_string()),
            }
        }
    }
}

/// 上传单个文件，按整批任务的累计状态推进进度；处理同名冲突。
/// `resume` 为 true（传输失败后的重试）时：目标已有部分数据 → 从断点续传；
/// 目标大小与源一致 → 视为已完成直接跳过（不弹冲突框）。
#[allow(clippy::too_many_arguments)]
async fn upload_file_core(
    state: &AppState,
    sftp: &SftpSession,
    local: &Path,
    remote: &str,
    label: &str,
    on_progress: &tauri::ipc::Channel<TransferProgress>,
    total: u64,
    total_files: u64,
    transferred: &mut u64,
    files_done: &mut u64,
    skipped: &mut u64,
    mode: &mut ConflictMode,
    resume: bool,
) -> Result<(), String> {
    use russh_sftp::protocol::OpenFlags;
    use std::io::SeekFrom;
    use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};

    let local_size = tokio::fs::metadata(local)
        .await
        .map_err(|e| format!("读取本地文件信息失败：{e}"))?
        .len();
    let remote_meta = sftp.metadata(remote).await.ok();
    let remote_size = remote_meta.as_ref().map(|m| m.len()).unwrap_or(0);

    // 断点续传：目标已有部分数据时直接从断点继续（不弹冲突框）
    let mut resume_offset = 0u64;
    if resume && remote_meta.is_some() {
        if remote_size == local_size {
            // 已完整上传：计入进度与文件数后跳过
            *transferred += remote_size;
            *files_done += 1;
            let _ = on_progress.send(TransferProgress {
                transferred: *transferred,
                total,
                percent: if total > 0 {
                    *transferred as f64 / total as f64 * 100.0
                } else {
                    100.0
                },
                file: Some(label.to_string()),
                files: *files_done,
                total_files,
                skipped: *skipped,
                conflict: None,
            });
            return Ok(());
        } else if remote_size > 0 && remote_size < local_size {
            resume_offset = remote_size;
        }
        // remote_size > local_size：目标异常大于源，落入常规冲突流程让用户决定
    }

    // 续传直接复用目标路径；否则走常规冲突处理（覆盖 / 跳过 / 重命名）
    let (skip, actual_remote) = if resume && resume_offset > 0 {
        (false, remote.to_string())
    } else {
        handle_conflict(
            state,
            remote,
            remote_meta.is_some(),
            mode,
            on_progress,
            Some(sftp),
            *transferred,
            total,
            *files_done,
            total_files,
            skipped,
        )
        .await?
    };
    if skip {
        *files_done += 1;
        return Ok(());
    }

    let mut local_file = tokio::fs::File::open(local)
        .await
        .map_err(|e| format!("打开本地文件失败：{e}"))?;
    let mut remote_file = if resume_offset > 0 {
        // 续传：WRITE|CREATE 不带 TRUNCATE，保留已有部分数据
        sftp.open_with_flags(&actual_remote, OpenFlags::WRITE | OpenFlags::CREATE)
            .await
            .map_err(|e| format!("打开远程文件失败：{e}"))?
    } else {
        sftp.open_with_flags(
            &actual_remote,
            OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::TRUNCATE,
        )
        .await
        .map_err(|e| format!("打开远程文件失败：{e}"))?
    };

    if resume_offset > 0 {
        // 打开后校验实际大小：防止“检查与打开之间文件被删除/替换”的竞态
        // 导致 seek 到不存在的偏移而在文件头留下空洞（稀疏零字节损坏文件）
        let actual = remote_file
            .metadata()
            .await
            .map_err(|e| format!("读取远程文件大小失败：{e}"))?
            .len();
        if actual == 0 {
            resume_offset = 0; // 目标刚被新建（竞态）：从 0 开始
        } else if actual != resume_offset {
            if actual < local_size {
                resume_offset = actual; // 以实际大小为准继续
            } else {
                return Err("远程目标大小异常，无法续传，请移除后重试".to_string());
            }
        }
        if resume_offset > 0 {
            local_file
                .seek(SeekFrom::Start(resume_offset))
                .await
                .map_err(|e| format!("定位本地文件失败：{e}"))?;
            remote_file
                .seek(SeekFrom::Start(resume_offset))
                .await
                .map_err(|e| format!("定位远程文件失败：{e}"))?;
            *transferred += resume_offset;
        }
    }

    let mut buf = vec![0u8; 131_072];
    // 进度事件节流：至少间隔 100ms 才推送一次，
    // 避免大文件（每 128KB 一次）造成 IPC 与前端 setState 高频洪泛
    let mut last_progress = std::time::Instant::now() - Duration::from_millis(100);
    loop {
        let n = local_file
            .read(&mut buf)
            .await
            .map_err(|e| format!("读取本地文件失败：{e}"))?;
        if n == 0 {
            break;
        }
        // 网络中断或服务器停止响应时，write_all 可能无限阻塞
        // 加超时保护，避免前端进度条永远卡住
        let _ = tokio::time::timeout(SFTP_IO_TIMEOUT, async {
            remote_file
                .write_all(&buf[..n])
                .await
                .map_err(|e| format!("写入远程文件失败：{e}"))
        })
        .await
        .map_err(|_| format!("写入远程文件超时（30 秒）：{label}"))??;
        *transferred += n as u64;
        if last_progress.elapsed() < Duration::from_millis(100) {
            continue;
        }
        last_progress = std::time::Instant::now();
        let _ = on_progress.send(TransferProgress {
            transferred: *transferred,
            total,
            percent: if total > 0 {
                *transferred as f64 / total as f64 * 100.0
            } else {
                100.0
            },
            file: Some(label.to_string()),
            files: *files_done,
            total_files,
            skipped: *skipped,
            conflict: None,
        });
    }
    // 文件结束：确保推送一次最终进度（目录传输时 send_done 会再补 100%）
    let _ = on_progress.send(TransferProgress {
        transferred: *transferred,
        total,
        percent: if total > 0 {
            *transferred as f64 / total as f64 * 100.0
        } else {
            100.0
        },
        file: Some(label.to_string()),
        files: *files_done,
        total_files,
        skipped: *skipped,
        conflict: None,
    });
    remote_file
        .close()
        .await
        .map_err(|e| format!("关闭远程文件失败：{e}"))?;
    *files_done += 1;
    Ok(())
}

/// 下载单个文件，按整批任务的累计状态推进进度；处理同名冲突。
/// `resume` 为 true（传输失败后的重试）时：本地已有部分数据 → 从断点续传；
/// 本地大小与远端一致 → 视为已完成直接跳过（不弹冲突框）。
#[allow(clippy::too_many_arguments)]
async fn download_file_core(
    state: &AppState,
    sftp: &SftpSession,
    remote: &str,
    local: &Path,
    label: &str,
    on_progress: &tauri::ipc::Channel<TransferProgress>,
    total: u64,
    total_files: u64,
    transferred: &mut u64,
    files_done: &mut u64,
    skipped: &mut u64,
    mode: &mut ConflictMode,
    resume: bool,
) -> Result<(), String> {
    use std::io::SeekFrom;
    use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};

    let remote_size = sftp
        .metadata(remote)
        .await
        .map_err(|e| format!("获取远程文件信息失败：{e}"))?
        .len();
    let local_meta = tokio::fs::metadata(local).await.ok();
    let local_size = local_meta.as_ref().map(|m| m.len()).unwrap_or(0);
    let local_str = local.to_string_lossy().to_string();

    // 断点续传：本地已有部分数据时直接从断点继续（不弹冲突框）
    let mut resume_offset = 0u64;
    if resume && local_meta.is_some() {
        if local_size == remote_size {
            // 已完整下载：计入进度与文件数后跳过
            *transferred += local_size;
            *files_done += 1;
            let _ = on_progress.send(TransferProgress {
                transferred: *transferred,
                total,
                percent: if total > 0 {
                    *transferred as f64 / total as f64 * 100.0
                } else {
                    100.0
                },
                file: Some(label.to_string()),
                files: *files_done,
                total_files,
                skipped: *skipped,
                conflict: None,
            });
            return Ok(());
        } else if local_size > 0 && local_size < remote_size {
            resume_offset = local_size;
        }
        // local_size > remote_size：本地异常大于远端，落入常规冲突流程让用户决定
    }

    // 续传直接复用本地路径；否则走常规冲突处理（覆盖 / 跳过 / 重命名）
    let (skip, actual_local) = if resume && resume_offset > 0 {
        (false, local_str)
    } else {
        handle_conflict(
            state,
            &local_str,
            local_meta.is_some(),
            mode,
            on_progress,
            None,
            *transferred,
            total,
            *files_done,
            total_files,
            skipped,
        )
        .await?
    };
    if skip {
        *files_done += 1;
        return Ok(());
    }

    let mut remote_file = sftp
        .open(remote)
        .await
        .map_err(|e| format!("打开远程文件失败：{e}"))?;
    let mut local_file = if resume_offset > 0 {
        // 续传：追加模式，保留已有部分数据
        tokio::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&actual_local)
            .await
            .map_err(|e| format!("打开本地文件失败：{e}"))?
    } else {
        tokio::fs::File::create(&actual_local)
            .await
            .map_err(|e| format!("创建本地文件失败：{e}"))?
    };

    if resume_offset > 0 {
        remote_file
            .seek(SeekFrom::Start(resume_offset))
            .await
            .map_err(|e| format!("定位远程文件失败：{e}"))?;
        *transferred += resume_offset;
    }

    let mut buf = vec![0u8; 131_072];
    // 进度事件节流：至少间隔 100ms 才推送一次
    let mut last_progress = std::time::Instant::now() - Duration::from_millis(100);
    loop {
        let n = tokio::time::timeout(SFTP_IO_TIMEOUT, async {
            remote_file
                .read(&mut buf)
                .await
                .map_err(|e| format!("读取远程文件失败：{e}"))
        })
        .await
        .map_err(|_| format!("读取远程文件超时（30 秒）：{label}"))??;
        if n == 0 {
            break;
        }
        // 本地磁盘写入加超时保护（网络文件系统挂载的本地盘也可能卡住）
        tokio::time::timeout(SFTP_IO_TIMEOUT, async {
            local_file
                .write_all(&buf[..n])
                .await
                .map_err(|e| format!("写入本地文件失败：{e}"))
        })
        .await
        .map_err(|_| format!("写入本地文件超时（30 秒）：{label}"))??;
        *transferred += n as u64;
        if last_progress.elapsed() < Duration::from_millis(100) {
            continue;
        }
        last_progress = std::time::Instant::now();
        let _ = on_progress.send(TransferProgress {
            transferred: *transferred,
            total,
            percent: if total > 0 {
                *transferred as f64 / total as f64 * 100.0
            } else {
                100.0
            },
            file: Some(label.to_string()),
            files: *files_done,
            total_files,
            skipped: *skipped,
            conflict: None,
        });
    }
    // 文件结束：确保推送一次最终进度
    let _ = on_progress.send(TransferProgress {
        transferred: *transferred,
        total,
        percent: if total > 0 {
            *transferred as f64 / total as f64 * 100.0
        } else {
            100.0
        },
        file: Some(label.to_string()),
        files: *files_done,
        total_files,
        skipped: *skipped,
        conflict: None,
    });
    local_file
        .sync_all()
        .await
        .map_err(|e| format!("写入本地文件失败：{e}"))?;
    *files_done += 1;
    Ok(())
}

/// 发送完成事件（目录传输收尾，让进度条显示 100%）
fn send_done(
    on_progress: &tauri::ipc::Channel<TransferProgress>,
    total: u64,
    total_files: u64,
    skipped: u64,
) {
    let _ = on_progress.send(TransferProgress {
        transferred: total,
        total,
        percent: 100.0,
        file: None,
        files: total_files,
        total_files,
        skipped,
        conflict: None,
    });
}

/// 上传文件或目录到远程（目录自动递归创建，带进度事件与同名冲突处理）。
/// `resume` 为 true 时（传输失败后的重试）自动断点续传。
#[tauri::command]
pub async fn sftp_upload(
    state: State<'_, AppState>,
    session_id: String,
    local_path: String,
    remote_path: String,
    on_progress: tauri::ipc::Channel<TransferProgress>,
    resume: bool,
) -> Result<(), String> {
    let sftp = open_sftp(&state, &session_id).await?;
    let local = PathBuf::from(&local_path);
    let meta = tokio::fs::metadata(&local)
        .await
        .map_err(|e| format!("读取本地文件信息失败：{e}"))?;

    let mut mode = ConflictMode::Ask;
    let mut skipped = 0u64;

    if meta.is_dir() {
        // ---- 目录：递归上传 ----
        let mut dirs = Vec::new();
        let mut files = Vec::new();
        collect_local_tree(&local, "", &mut dirs, &mut files).await?;
        let total: u64 = files.iter().map(|(_, s)| *s).sum();
        let total_files = files.len() as u64;

        let base = remote_path.trim_end_matches('/');
        ensure_remote_dir(&sftp, base).await?;
        for d in &dirs {
            ensure_remote_dir(&sftp, &format!("{base}/{d}")).await?;
        }

        let mut transferred = 0u64;
        let mut files_done = 0u64;
        for (rel, _) in &files {
            upload_file_core(
                state.inner(),
                &sftp,
                &local.join(rel),
                &format!("{base}/{rel}"),
                rel,
                &on_progress,
                total,
                total_files,
                &mut transferred,
                &mut files_done,
                &mut skipped,
                &mut mode,
                resume,
            )
            .await?;
        }
        send_done(&on_progress, total, total_files, skipped);
    } else {
        // ---- 单个文件 ----
        let total = meta.len();
        let label = local
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| local_path.clone());
        let mut transferred = 0u64;
        let mut files_done = 0u64;
        upload_file_core(
            state.inner(),
            &sftp,
            &local,
            &remote_path,
            &label,
            &on_progress,
            total,
            1,
            &mut transferred,
            &mut files_done,
            &mut skipped,
            &mut mode,
            resume,
        )
        .await?;
    }
    Ok(())
}

/// 下载远程文件或目录到本地（目录自动递归创建，带进度事件与同名冲突处理）。
/// `resume` 为 true 时（传输失败后的重试）自动断点续传。
#[tauri::command]
pub async fn sftp_download(
    state: State<'_, AppState>,
    session_id: String,
    remote_path: String,
    local_path: String,
    on_progress: tauri::ipc::Channel<TransferProgress>,
    resume: bool,
) -> Result<(), String> {
    let sftp = open_sftp(&state, &session_id).await?;
    let meta = sftp
        .metadata(&remote_path)
        .await
        .map_err(|e| format!("获取远程文件信息失败：{e}"))?;

    let mut mode = ConflictMode::Ask;
    let mut skipped = 0u64;

    if meta.is_dir() {
        // ---- 目录：递归下载 ----
        let local_root = PathBuf::from(&local_path);
        tokio::fs::create_dir_all(&local_root)
            .await
            .map_err(|e| format!("创建本地目录失败：{e}"))?;

        let (dirs, files) = collect_remote_tree(&sftp, &remote_path).await?;
        for d in &dirs {
            tokio::fs::create_dir_all(local_root.join(d))
                .await
                .map_err(|e| format!("创建本地目录失败：{e}"))?;
        }
        let total: u64 = files.iter().map(|(_, s)| *s).sum();
        let total_files = files.len() as u64;

        let base = remote_path.trim_end_matches('/');
        let mut transferred = 0u64;
        let mut files_done = 0u64;
        for (rel, _) in &files {
            download_file_core(
                state.inner(),
                &sftp,
                &format!("{base}/{rel}"),
                &local_root.join(rel),
                rel,
                &on_progress,
                total,
                total_files,
                &mut transferred,
                &mut files_done,
                &mut skipped,
                &mut mode,
                resume,
            )
            .await?;
        }
        send_done(&on_progress, total, total_files, skipped);
    } else {
        // ---- 单个文件 ----
        let total = meta.len();
        let label = remote_path
            .rsplit('/')
            .next()
            .unwrap_or(&remote_path)
            .to_string();
        let mut transferred = 0u64;
        let mut files_done = 0u64;
        download_file_core(
            state.inner(),
            &sftp,
            &remote_path,
            Path::new(&local_path),
            &label,
            &on_progress,
            total,
            1,
            &mut transferred,
            &mut files_done,
            &mut skipped,
            &mut mode,
            resume,
        )
        .await?;
    }
    Ok(())
}

/// 回复一次传输冲突的选择（覆盖 / 跳过 / 重命名 / 全部 / 取消）
#[tauri::command]
pub async fn sftp_resolve_conflict(
    state: State<'_, AppState>,
    request_id: String,
    action: ConflictChoice,
) -> Result<(), String> {
    let mut resolvers = state.conflict_resolvers.lock().await;
    if let Some(tx) = resolvers.remove(&request_id) {
        let _ = tx.send(action);
    }
    Ok(())
}
