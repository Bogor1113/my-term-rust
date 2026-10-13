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
    map: &'a std::sync::Mutex<HashMap<String, tokio::sync::oneshot::Sender<ConflictChoice>>>,
    request_id: Option<String>,
}

impl Drop for PendingConflictGuard<'_> {
    fn drop(&mut self) {
        if let Some(id) = self.request_id.take() {
            // 关键：不能用 `blocking_lock()`。tokio 的实现是
            // `block_on(self.lock())`，而 `block_on` 内部对
            // `try_enter_blocking_region()` 做 `.expect(...)` —— 在 runtime 线程上
            // 调用会**直接 panic**。本守卫正是在 async fn 里创建的，Drop 必然
            // 发生在 tokio worker 线程上，因此这条路径必然炸。
            //
            // 本守卫在 async fn 中创建，Drop 必然发生在 tokio worker 线程上，
            // 因此绝不能用 tokio Mutex 的 blocking_lock（内部 block_on 会对
            // try_enter_blocking_region() 做 expect 而 panic）。AppState 里的
            // conflict_resolvers 已改为 std::sync::Mutex，这里 lock() 是纯粹的
            // 同步临界区（内部只有一次 HashMap remove），不会跨线程长期阻塞，
            // 也不会 panic。
            let mut map = self.map.lock().unwrap_or_else(|e| e.into_inner());
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

    // Handle 被会话共享（终端输入 / 监控 / 端口转发都抢同一把锁），必须带超时：
    // russh 的 channel_open_session 会等服务端应答且无内部超时，服务端收下
    // 通道后不回包时这把锁会被无限期持有，该会话的 SFTP 与转发将全部瘫痪。
    let channel = tokio::time::timeout(CHANNEL_OPEN_TIMEOUT, async {
            let handle = handle_arc.lock().await;
            let channel = handle
                .channel_open_session()
                .await
                .map_err(|e| format!("打开通道失败：{e}"))?;
            channel
                .request_subsystem(true, "sftp")
                .await
                .map_err(|e| format!("请求 SFTP 子系统失败：{e}"))?;
            Ok::<_, String>(channel)
        })
        .await
        .map_err(|_| format!("打开 SFTP 子系统超时（{CHANNEL_OPEN_TIMEOUT:?}）"))??;
    SftpSession::new(channel.into_stream())
        .await
        .map_err(|e| format!("初始化 SFTP 失败：{e}"))
}

/// 打开 SSH 通道 / 请求子系统的超时。
/// russh 侧等待服务端应答没有内部 deadline，不加限制则共享的 Handle 锁
/// 会被异常服务器无限期持有。
const CHANNEL_OPEN_TIMEOUT: Duration = Duration::from_secs(15);

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
    let mut channel = tokio::time::timeout(CHANNEL_OPEN_TIMEOUT, async {
            let handle = handle_arc.lock().await;
            let chan = handle
                .channel_open_session()
                .await
                .map_err(|e| format!("打开通道失败：{e}"))?;
            chan.exec(true, "echo $HOME".as_bytes())
                .await
                .map_err(|e| format!("执行命令失败：{e}"))?;
            Ok::<_, String>(chan)
        })
        .await
        .map_err(|_| format!("获取 HOME 目录超时（{CHANNEL_OPEN_TIMEOUT:?}）"))??;
    // channel.wait() 没有任何超时：服务器开了 exec 却不回 EOF 时，Tauri 命令会
    // 一直挂着，前端 await 永不结束 —— 而 sftp_home 在每次打开 SFTP 面板时都会调用。
    let mut output = Vec::new();
    let collected = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            match channel.wait().await {
                Some(ChannelMsg::Data { data }) => {
                    output.extend_from_slice(&data);
                    if output.len() > 64 * 1024 {
                        return Err("远程输出异常（超过 64KB）".to_string());
                    }
                }
                Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => break,
                Some(_) => {}
            }
        }
        Ok::<_, String>(())
    })
    .await
    .map_err(|_| "获取 home 目录超时（10 秒）".to_string())?;
    collected?;
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
    // 破坏性操作的服务端护栏：path 完全由前端传入，递归删除会一路展开。
    // 没有这层检查时，一个构造出来的 "/"、"/home/user" 或用户主目录
    // 就能被整棵删掉 —— 界面上的确认框是唯一防线，而它可以被绕过。
    let normalized = normalize_remote_path(&path);
    if recursive && is_dangerous_delete_target(&normalized) {
        return Err(format!(
            "拒绝递归删除「{normalized}」：这是用户的根目录或 home 目录，风险过高"
        ));
    }
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
            // 条目数上限保护（含目录）：防止超大目录全部载入内存导致 OOM
            if files.len() + dirs.len() >= MAX_COLLECT_FILES {
                return Err(format!(
                    "该目录包含超过 {MAX_COLLECT_FILES} 个条目，请缩小范围后再试"
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

/// 校验远端返回的文件名是否可以安全地拼到本地路径上。
///
/// 只放行"单个路径分量"：不含任何分隔符（`/` 与 `\`）、不是 `.`/`..`、
/// 不含 Windows 保留的盘符形态、也不是绝对路径。反斜杠必须显式拒绝 ——
/// POSIX 允许 `\` 出现在文件名里，而 Windows 把它当分隔符，
/// 这正是跨平台路径穿越的入口。
fn is_safe_remote_name(name: &str) -> bool {
    if name.is_empty() || name == "." || name == ".." {
        return false;
    }
    if name.contains('/') || name.contains('\\') {
        return false;
    }
    // 形如 "C:" 的盘符 / 任何以冒号开头的绝对形式在 Windows 上都是逃逸路径
    if name.contains(':') {
        return false;
    }
    if Path::new(name).is_absolute() {
        return false;
    }
    true
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
            // 名称来自**远端服务器**，而这些相对路径最终会被 join 到本地下载目录上。
            // POSIX 下反斜杠是合法文件名字符，所以 `..\..\evil.dll` 或
            // `C:\Users\x\y` 完全可能从 read_dir 返回：前者能逃出本地根目录，
            // 后者会让 Path::join 直接丢弃基路径。不做校验就等于把
            // "远端可控内容"变成"本地任意位置写文件"。
            if !is_safe_remote_name(&name) {
                return Err(format!("远端目录包含非法文件名，已中止：{name}"));
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
            // 上限保护必须把 dirs 一起计入：只数 files 的话，
            // 一个塞满空目录的树（files 始终为 0）能绕过检查把 dirs 撑爆内存。
            if files.len() + dirs.len() >= MAX_COLLECT_FILES {
                return Err(format!(
                    "该目录包含超过 {MAX_COLLECT_FILES} 个条目，请缩小范围后再试"
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
        // 远端根目录 "/"：metadata 可能不被支持而报错，但它一定是目录。
        // 不能一律当作"不存在"去 create_dir —— 必然失败并让根目录下的
        // 整批上传中止。
        Ok(m) if m.is_dir() => Ok(()),
        Err(e) if is_not_found(&e) && path == "/" => Ok(()),
        Ok(_) => Err(format!("远程路径已存在且不是目录：{path}")),
        Err(e) if !is_not_found(&e) => Err(format!("读取远程目录失败：{e}")),
        Err(_) => match sftp.create_dir(path).await {
            Ok(()) => Ok(()),
            // check-then-act：确认不存在之后、真正创建之前，另一个传输
            // 可能已经把同名目录建好了。此时 EEXIST 不是错误，复查即可。
            Err(e) => match sftp.metadata(path).await {
                Ok(m) if m.is_dir() => Ok(()),
                Ok(_) => Err(format!("远程路径已存在且不是目录：{path}")),
                Err(_) => Err(format!("创建远程目录失败：{e}")),
            },
        },
    }
}

/// 归一化远程路径（仅做等价规范化，不解析符号链接）
fn normalize_remote_path(p: &str) -> String {
    let mut out: Vec<&str> = Vec::new();
    for seg in p.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                out.pop();
            }
            s => out.push(s),
        }
    }
    if out.is_empty() {
        "/".to_string()
    } else {
        format!("/{}", out.join("/"))
    }
}

/// 判断一个路径是否是"递归删除绝不能碰"的高危目标。
///
/// 覆盖：根目录 `/`、以及 `/home/<user>` 或 `/Users/<user>` 这类家目录。
/// 这几个位置被递归删除等于把整台机器的用户数据清空。
fn is_dangerous_delete_target(normalized: &str) -> bool {
    if normalized == "/" || normalized.is_empty() {
        return true;
    }
    let segs: Vec<&str> = normalized.split('/').filter(|s| !s.is_empty()).collect();
    if segs.len() == 2 && (segs[0] == "home" || segs[0] == "Users") {
        return true;
    }
    false
}

/// 拼接远程路径。base 为根 "/" 时不能产出 "//xxx"。
#[inline]
fn join_remote(base: &str, rel: &str) -> String {
    if base.ends_with('/') {
        format!("{base}{rel}")
    } else {
        format!("{base}/{rel}")
    }
}

/// 判断一个 SFTP 错误是否为「文件/目录不存在」。
///
/// russh-sftp 的 error 模块是私有的，只能按 Display 文本匹配 —— 这是该库
/// 在不启用额外 feature 时的唯一可用手段。目的是把"确实不存在"与
/// "权限不足 / IO 失败"区分开：前者可以安全地认为目标名空闲，后者不行。
fn is_not_found(e: &russh_sftp::client::error::Error) -> bool {
    let msg = e.to_string();
    msg.contains("No such file") || msg.contains("no such file")
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
    // 分隔符必须取自**实际切分的位置**，而不是扫描整个路径。
    // Linux 上的目录名里出现反斜杠是完全合法的（`/data/my\dir/file.txt`），
    // 按 contains('\\') 判断会给这些路径拼出 `dir\name (1)` 这种错位结果。
    let sep = match target.rfind(['/', '\\']) {
        Some(idx) => target.as_bytes()[idx] as char,
        None => '/',
    };
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
        // 只有"确实不存在"才算空闲。权限不足 / IO 错误不能被当成"名字可用"：
        // 否则会返回一个随后 open 必然失败的路径，错误信息还指向一个
        // 与真实原因无关的地方。
        let exists = match remote {
            Some(s) => match s.metadata(&full).await {
                Ok(_) => true,
                Err(e) if is_not_found(&e) => false,
                Err(_) => true, // 无法确认 → 保守认为已占用
            },
            None => match tokio::fs::metadata(&full).await {
                Ok(_) => true,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
                Err(_) => true,
            },
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
                .unwrap_or_else(|e| e.into_inner())
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
            state
                .conflict_resolvers
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(&request_id);
            // 解除守卫后再做任何可能失败/被取消的操作（下面 next_available_name
            // 有网络往返）。守卫保持武装状态跨越 await 时，一旦 future 被取消，
            // Drop 会在 runtime 线程上跑 —— 那条路径不能依赖任何加锁。
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
    // metadata 的错误必须区分"不存在"与"其它失败"：一律 .ok() 会让权限不足
    // 被当成"远端文件不存在"，于是跳过冲突检测直接覆盖 —— 覆盖失败时用户
    // 看到的却是另一个毫不相干的错误。
    let remote_meta = match sftp.metadata(remote).await {
        Ok(m) => Some(m),
        Err(e) if is_not_found(&e) => None,
        Err(e) => return Err(format!("读取远程文件信息失败：{e}")),
    };
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
    // 同上：本地 metadata 只把 NotFound 当作"文件不存在"，
    // 权限/IO 错误不能被误判为需要走冲突流程。
    let local_meta = match tokio::fs::metadata(local).await {
        Ok(m) => Some(m),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(format!("读取本地文件信息失败：{e}")),
    };
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
        // 续传：WRITE|CREATE 且**不带** APPEND。
        // 用 append(true) 时写入位置永远由文件系统决定为"当前文件末尾"，
        // 代码里的 seek 完全不起作用；而 resume_offset 是在上面 metadata()
        // 那次网络往返之前读到的，若这期间文件被改写/增长，续传数据就会被追加到
        // 错误的偏移上，产生内容错位/重复的损坏文件（上传路径 upload_file_core
        // 早就为此加了打开后复校，这里是对称的漏网之处）。
        tokio::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(false)
            .open(&actual_local)
            .await
            .map_err(|e| format!("打开本地文件失败：{e}"))?
    } else {
        tokio::fs::File::create(&actual_local)
            .await
            .map_err(|e| format!("创建本地文件失败：{e}"))?
    };

    if resume_offset > 0 {
        // 打开后复校实际大小：防止"检查与打开之间文件被删除/替换/截断"的竞态。
        // 与 upload_file_core 同一套处理，只是方向相反（那边看远端，这边看本地）。
        let actual = local_file
            .metadata()
            .await
            .map_err(|e| format!("读取本地文件大小失败：{e}"))?
            .len();
        if actual == 0 {
            resume_offset = 0; // 目标刚被清空：退化为从 0 开始
        } else if actual != resume_offset {
            if actual < remote_size {
                resume_offset = actual; // 以实际大小为准继续
            } else {
                return Err("本地目标大小异常，无法续传，请移除后重试".to_string());
            }
        }
        remote_file
            .seek(SeekFrom::Start(resume_offset))
            .await
            .map_err(|e| format!("定位远程文件失败：{e}"))?;
        local_file
            .seek(SeekFrom::Start(resume_offset))
            .await
            .map_err(|e| format!("定位本地文件失败：{e}"))?;
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
///
/// `transferred` 必须传真实传输量：原实现硬写 `total`，于是当用户选择"跳过"
/// 若干同名文件时，前端仍被告知"已传输全部字节"，进度条直接满格 —— 报告的数据
/// 与实际发生的事不符。percent 同样按真实比例计算，但只要任务整体结束就收尾。
fn send_done(
    on_progress: &tauri::ipc::Channel<TransferProgress>,
    transferred: u64,
    total: u64,
    total_files: u64,
    skipped: u64,
) {
    let _ = on_progress.send(TransferProgress {
        transferred,
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

        // 根目录 "/" 被 trim 成空串，后续拼出的路径会变成 "/sub/file"（少一层），
        // 而 ensure_remote_dir("") 更是必然失败。这里保留根目录本身。
        let base = remote_path.trim_end_matches('/');
        let base = if base.is_empty() { "/" } else { base };
        ensure_remote_dir(&sftp, base).await?;
        for d in &dirs {
            ensure_remote_dir(&sftp, &join_remote(base, d)).await?;
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
        send_done(&on_progress, transferred, total, total_files, skipped);
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
        // 同上：base 为空表示远端根目录
        let base = if base.is_empty() { "/" } else { base };
        let mut transferred = 0u64;
        let mut files_done = 0u64;
        for (rel, _) in &files {
            download_file_core(
                state.inner(),
                &sftp,
                &join_remote(base, rel),
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
        send_done(&on_progress, transferred, total, total_files, skipped);
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
    let mut resolvers = state
        .conflict_resolvers
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    if let Some(tx) = resolvers.remove(&request_id) {
        if tx.send(action).is_err() {
            // 接收端（传输任务）已经不在了：传输被取消或超时结束。
            // 静默丢弃即可，但值得留痕以便排查。
            eprintln!("[sftp] 冲突 {request_id} 的接收端已消失，选择未被消费");
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_path_traversal_names() {
        // 反斜杠在 POSIX 下是合法文件名字符，但落到 Windows 上就是分隔符，
        // 这是把"远端可控名字"变成"本地任意位置写文件"的入口，必须拒绝。
        assert!(!is_safe_remote_name(r"..\..\..\Windows\System32\evil.dll"));
        assert!(!is_safe_remote_name(".."));
        assert!(!is_safe_remote_name("."));
        assert!(!is_safe_remote_name(""));
        assert!(!is_safe_remote_name("a/b"));
        assert!(!is_safe_remote_name(r"a\b"));
        assert!(!is_safe_remote_name(r"C:\Users\x\y"));
        assert!(!is_safe_remote_name("C:evil"));
    }

    #[test]
    fn accepts_ordinary_names() {
        assert!(is_safe_remote_name("report.pdf"));
        assert!(is_safe_remote_name("中文文件名.txt"));
        assert!(is_safe_remote_name("a.b.c"));
        assert!(is_safe_remote_name("..hidden"));
        assert!(is_safe_remote_name("file..name"));
    }

    #[test]
    fn blocks_dangerous_recursive_delete_targets() {
        assert!(is_dangerous_delete_target("/"));
        assert!(is_dangerous_delete_target("/home/alice"));
        assert!(is_dangerous_delete_target("/Users/bob"));
        // 带 .. 的绕过写法：调用方（sftp_remove）会先做规范化，
        // 这里验证规范化之后确实被拦住
        assert!(is_dangerous_delete_target(&normalize_remote_path("/home/../home/alice")));
        assert!(is_dangerous_delete_target(&normalize_remote_path("/./")));
        // 正常目录不应被拦
        assert!(!is_dangerous_delete_target("/home"));
        assert!(!is_dangerous_delete_target("/home/alice/project"));
        assert!(!is_dangerous_delete_target("/var/log"));
        assert!(!is_dangerous_delete_target("/Users"));
    }

    #[test]
    fn normalize_remote_path_resolves_dot_segments() {
        assert_eq!(normalize_remote_path("/a/b/../c"), "/a/c");
        assert_eq!(normalize_remote_path("/a//b/"), "/a/b");
        assert_eq!(normalize_remote_path("/a/./b"), "/a/b");
        assert_eq!(normalize_remote_path("/.."), "/");
        assert_eq!(normalize_remote_path("/"), "/");
        assert_eq!(normalize_remote_path("/home/alice/../.."), "/");
    }

    #[test]
    fn join_remote_never_doubles_slash() {
        assert_eq!(join_remote("/", "a/b.txt"), "/a/b.txt");
        assert_eq!(join_remote("/home", "a/b.txt"), "/home/a/b.txt");
        assert_eq!(join_remote("/home/", "a.txt"), "/home/a.txt");
    }

    #[test]
    fn remote_root_is_not_trimmed_away() {
        // 回归：trim_end_matches('/') 会把 "/" 变成 ""，
        // 导致 ensure_remote_dir("") 失败、下载路径少一层。
        let trimmed = "/".trim_end_matches('/');
        assert_eq!(trimmed, "");
        let base = if trimmed.is_empty() { "/" } else { trimmed };
        assert_eq!(base, "/");
        assert_eq!(join_remote(base, "x.txt"), "/x.txt");
    }
}