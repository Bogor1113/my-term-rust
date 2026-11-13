//! AI Agent 工具执行模块
//!
//! Agent 与普通对话的区别：模型可以在「一轮」里要求调用工具，由前端把工具调用
//! 交给这里执行，再把输出回灌给模型，直到模型给出最终答复。
//!
//! 本模块只做两件事：
//! 1. 暴露 OpenAI function-calling 的工具定义（`tool_definitions`）；
//! 2. 在**当前 SSH 会话**上安全地执行这些工具（`agent_run_command` /
//!    `agent_write_script`）。
//!
//! 为什么不走交互式 PTY：PTY 输出混着提示符、回显、分页器转义序列，模型很难
//! 读懂；exec 通道拿到的是干净的 stdout / stderr / 退出码，语义明确。

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use russh::ChannelMsg;
use russh_sftp::protocol::OpenFlags;
use serde::Serialize;
use tauri::{AppHandle, Manager};
use tokio::io::AsyncWriteExt;

use crate::AppState;

/// 单次命令 / 脚本返回给模型的输出上限。
/// 模型上下文很贵，而且异常命令（`yes`、`cat /dev/urandom`）可以无限输出；
/// 没有闸门会一路吃到 OOM。
const MAX_OUTPUT_BYTES: usize = 256 * 1024;

/// 写入脚本内容的大小上限（256KB 足够任何运维脚本）
const MAX_SCRIPT_BYTES: usize = 256 * 1024;

/// 命令默认超时 / 允许的最大超时
const DEFAULT_TIMEOUT_SECS: u64 = 60;
const MAX_TIMEOUT_SECS: u64 = 300;

/// 打开通道的超时。russh 等不到服务端应答时没有内部 deadline，
/// 共享 Handle 会被无限期占住，导致该会话其它操作全部卡死。
const CHANNEL_OPEN_TIMEOUT: Duration = Duration::from_secs(15);

/// 远程命令执行结果
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
    /// 输出是否因为超过上限被截断
    pub truncated: bool,
    pub duration_ms: u64,
}

/// 写脚本结果（可选择立即执行）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteScriptResult {
    pub path: String,
    pub bytes: usize,
    /// 实际设置的可执行位，如 "755"
    pub mode: String,
    /// 写入后立即执行的结果（execute=true 时存在）
    pub exec: Option<CommandResult>,
}

/// OpenAI function-calling 工具定义。
///
/// 描述写得尽量具体：模型能否正确使用工具，几乎完全取决于这里的措辞。
pub fn tool_definitions() -> serde_json::Value {
    serde_json::json!([
        {
            "type": "function",
            "function": {
                "name": "run_command",
                "description": "在远程服务器上执行一条非交互式 shell 命令，返回 stdout、stderr 和退出码。命令以当前登录用户身份通过 SSH exec 通道执行，工作目录是用户家目录，且不会加载 ~/.bashrc；如果 hdfs / hive / java 等命令提示 command not found，请在命令前加上 `source /etc/profile 2>/dev/null;` 或使用绝对路径。不要用它执行交互式程序（vim/top/less/su 等）；需要确认时请加非交互参数（-y / --batch / --force）。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "command": {
                            "type": "string",
                            "description": "要执行的完整 shell 命令，例如：`df -h` 或 `systemctl status nginx --no-pager`"
                        },
                        "description": {
                            "type": "string",
                            "description": "一句话说明这条命令的用途（用于向用户展示）"
                        },
                        "timeout_secs": {
                            "type": "integer",
                            "description": "超时秒数，1-300，默认 60。安装软件、编译等慢操作可以调大。"
                        }
                    },
                    "required": ["command"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "write_script",
                "description": "把一段 shell 脚本内容写到远程服务器指定路径，自动创建父目录并 chmod 755，可选择写入后立即执行并返回输出。适合生成运维、巡检、清理、部署脚本。相对路径相对于用户家目录。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "远程脚本路径，推荐绝对路径，例如 /home/ubuntu/check_disk.sh；相对路径基于家目录。"
                        },
                        "content": {
                            "type": "string",
                            "description": "脚本完整内容，建议包含 #!/usr/bin/env bash、set -euo pipefail 与必要注释。"
                        },
                        "description": {
                            "type": "string",
                            "description": "一句话说明脚本用途（用于向用户展示）"
                        },
                        "execute": {
                            "type": "boolean",
                            "description": "写入后是否立即执行脚本，默认 false。只有在确认脚本安全时才设为 true。"
                        },
                        "timeout_secs": {
                            "type": "integer",
                            "description": "若执行脚本，超时秒数 1-300，默认 60。"
                        }
                    },
                    "required": ["path", "content"]
                }
            }
        }
    ])
}

/// 从会话表取连接句柄（克隆 Arc 后立即释放全局锁；网络操作全部在锁外）
async fn session_handle(
    app: &AppHandle,
    session_id: &str,
) -> Result<Arc<tokio::sync::Mutex<russh::client::Handle<crate::ssh::Client>>>, String> {
    let state = app.state::<AppState>();
    let sessions = state.sessions.lock().await;
    let conn = sessions
        .get(session_id)
        .ok_or_else(|| "会话不存在或已断开".to_string())?;
    Ok(conn.handle.clone())
}

/// 在远程执行命令并收集 stdout / stderr / 退出码。
///
/// `cancel` 存在时每 400ms 检查一次取消标志：`channel.wait()` 本身会一直阻塞，
/// 命令长时间没有输出（例如 `sleep 300`）时只能靠周期性轮询才能响应「停止」。
async fn exec_collect(
    handle_arc: &Arc<tokio::sync::Mutex<russh::client::Handle<crate::ssh::Client>>>,
    command: &str,
    timeout_secs: u64,
    cancel: Option<&Arc<AtomicBool>>,
) -> Result<CommandResult, String> {
    let started = Instant::now();

    // 开通道可能因瞬时并发冲突失败：重试 3 次（与 cluster.rs 的策略一致）
    let mut channel = None;
    for attempt in 0..3u32 {
        let opened = tokio::time::timeout(CHANNEL_OPEN_TIMEOUT, async {
            let handle = handle_arc.lock().await;
            let chan = handle
                .channel_open_session()
                .await
                .map_err(|e| format!("打开通道失败：{e}"))?;
            chan.exec(true, command.as_bytes())
                .await
                .map_err(|e| format!("执行命令失败：{e}"))?;
            Ok::<_, String>(chan)
        })
        .await;

        match opened {
            Ok(Ok(chan)) => {
                channel = Some(chan);
                break;
            }
            Ok(Err(e)) => {
                if attempt == 2 {
                    return Err(e);
                }
                tokio::time::sleep(Duration::from_millis(300 * (attempt + 1) as u64)).await;
            }
            Err(_) => {
                return Err(format!(
                    "打开通道超时（{} 秒）",
                    CHANNEL_OPEN_TIMEOUT.as_secs()
                ))
            }
        }
    }
    let mut channel = channel.expect("channel retry loop always sets");

    let timeout = timeout_secs.clamp(1, MAX_TIMEOUT_SECS);
    let collected = tokio::time::timeout(Duration::from_secs(timeout), async {
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        let mut exit_code = -1;
        loop {
            // 有数据持续到达时 select 的 sleep 分支可能一直轮不到，
            // 因此在每轮开头也检查一次，保证「停止」不会被 `yes` 这类命令饿死。
            if let Some(flag) = cancel {
                if flag.load(Ordering::Relaxed) {
                    return Err("命令已被用户停止".to_string());
                }
            }
            let msg = match cancel {
                Some(flag) => tokio::select! {
                    m = channel.wait() => m,
                    _ = tokio::time::sleep(Duration::from_millis(400)) => {
                        if flag.load(Ordering::Relaxed) {
                            return Err("命令已被用户停止".to_string());
                        }
                        continue;
                    }
                },
                None => channel.wait().await,
            };
            match msg {
                Some(ChannelMsg::Data { data }) => {
                    stdout.extend_from_slice(&data);
                    if stdout.len() > MAX_OUTPUT_BYTES {
                        stdout.truncate(MAX_OUTPUT_BYTES);
                        break;
                    }
                }
                Some(ChannelMsg::ExtendedData { data, ext: _ }) => {
                    stderr.extend_from_slice(&data);
                    if stderr.len() > MAX_OUTPUT_BYTES {
                        stderr.truncate(MAX_OUTPUT_BYTES);
                        break;
                    }
                }
                Some(ChannelMsg::ExitStatus { exit_status }) => {
                    exit_code = exit_status as i32;
                }
                Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => break,
                Some(_) => {}
            }
        }
        Ok::<_, String>((stdout, stderr, exit_code))
    })
    .await;

    let (stdout, stderr, exit_code) = match collected {
        Ok(Ok(v)) => v,
        Ok(Err(e)) => {
            let _ = channel.close().await;
            return Err(e);
        }
        Err(_) => {
            // 超时：主动关闭通道，尽量让远端进程收到挂断信号
            let _ = channel.close().await;
            return Err(format!("命令执行超时（{timeout} 秒），已中止通道"));
        }
    };

    let truncated = stdout.len() >= MAX_OUTPUT_BYTES || stderr.len() >= MAX_OUTPUT_BYTES;
    Ok(CommandResult {
        stdout: String::from_utf8_lossy(&stdout).into_owned(),
        stderr: String::from_utf8_lossy(&stderr).into_owned(),
        exit_code,
        truncated,
        duration_ms: started.elapsed().as_millis() as u64,
    })
}

/// 明显会造成不可逆破坏的命令拦截。
///
/// 这不是「安全沙箱」——只拦最容易由模型幻觉触发、且后果无法挽回的一小撮：
/// 清空根目录 / 格式化磁盘 / 直接写块设备 / 关机重启 / fork 炸弹。
/// `rm -rf /var/log/app` 这类正常运维操作必须放行，否则 Agent 毫无用处。
fn catastrophic_reason(command: &str) -> Option<&'static str> {
    let lower = command.to_lowercase();

    // fork 炸弹（去掉空白后匹配）
    let compact: String = lower.chars().filter(|c| !c.is_whitespace()).collect();
    if compact.contains(":(){:|:&};:") || compact.contains("bomb(){bomb|bomb&};bomb") {
        return Some("疑似 fork 炸弹");
    }

    // 逐条语句检查（; && || | 换行 都视为分隔）
    for segment in lower.split([';', '\n', '|', '&']) {
        let tokens: Vec<&str> = segment.split_whitespace().collect();
        if tokens.is_empty() {
            continue;
        }

        // 命令可能是 /bin/rm 或 sudo rm
        let mut idx = 0;
        while idx < tokens.len() && matches!(tokens[idx], "sudo" | "command" | "env" | "nohup") {
            idx += 1;
        }
        if idx >= tokens.len() {
            continue;
        }
        let head = tokens[idx].rsplit('/').next().unwrap_or(tokens[idx]);

        match head {
            "mkfs" | "mkfs.ext4" | "mkfs.xfs" | "mke2fs" => return Some("格式化文件系统"),
            "shutdown" | "poweroff" | "reboot" | "halt" => return Some("关机 / 重启服务器"),
            "init" if tokens.get(idx + 1) == Some(&"0") || tokens.get(idx + 1) == Some(&"6") => {
                return Some("关机 / 重启服务器")
            }
            "dd" => {
                let writes_disk = tokens.iter().any(|t| {
                    t.starts_with("of=/dev/sd")
                        || t.starts_with("of=/dev/nvme")
                        || t.starts_with("of=/dev/vd")
                        || t.starts_with("of=/dev/hd")
                });
                if writes_disk {
                    return Some("直接写块设备");
                }
            }
            "rm" => {
                let flags: String = tokens[idx + 1..]
                    .iter()
                    .take_while(|t| t.starts_with('-'))
                    .copied()
                    .collect();
                let recursive = flags.contains('r') || flags.contains('R') || flags.contains("-recursive");
                let force = flags.contains('f');
                if recursive && force {
                    let targets = tokens[idx + 1..]
                        .iter()
                        .filter(|t| !t.starts_with('-'))
                        .copied()
                        .collect::<Vec<_>>();
                    if targets
                        .iter()
                        .any(|t| matches!(*t, "/" | "/*" | "~" | "~/" | "$home" | "${home}"))
                    {
                        return Some("递归删除根目录 / 家目录");
                    }
                }
            }
            "chmod" | "chown" => {
                // chmod -R 777 / 、chown -R user:user /
                if tokens.iter().any(|t| t.starts_with('-'))
                    && tokens
                        .iter()
                        .skip(idx + 1)
                        .any(|t| matches!(*t, "/" | "/*"))
                {
                    return Some("递归修改根目录权限");
                }
            }
            _ => {}
        }
    }
    None
}

fn reject_if_catastrophic(command: &str) -> Result<(), String> {
    if let Some(reason) = catastrophic_reason(command) {
        return Err(format!(
            "已拦截高危命令（{reason}）：{command}\n如果确实需要执行，请由用户手动在终端中运行。"
        ));
    }
    Ok(())
}

/// 取消标志注册表：request_id -> 标志位。进程级静态表，请求结束即移除。
fn cancel_flags() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    static FLAGS: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();
    FLAGS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 请求级清理守卫：正常结束 / 报错 / future 被 drop 都会摘除条目，
/// 避免反复「停止」在表里累积无人认领的标志位。
struct CancelGuard(String);

impl Drop for CancelGuard {
    fn drop(&mut self) {
        cancel_flags()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&self.0);
    }
}

/// 注册一个可取消请求，返回 (request_id, 标志位)。request_id 为空时不可取消。
fn register_cancel(request_id: Option<String>) -> Option<(String, Arc<AtomicBool>)> {
    let id = request_id?;
    let flag = Arc::new(AtomicBool::new(false));
    cancel_flags()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(id.clone(), flag.clone());
    Some((id, flag))
}

/// 「停止」Agent 正在执行的远程命令：置位标志，执行循环在 400ms 内关闭通道。
/// 请求不存在（已完成 / 从未发起）时静默成功。
#[tauri::command]
pub async fn agent_cancel(request_id: String) -> Result<(), String> {
    if let Some(flag) = cancel_flags()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&request_id)
    {
        flag.store(true, Ordering::Relaxed);
    }
    Ok(())
}

/// 执行一条远程命令（Agent 工具 `run_command` 的后端实现）
#[tauri::command]
pub async fn agent_run_command(
    app: AppHandle,
    session_id: String,
    command: String,
    timeout_secs: Option<u64>,
    request_id: Option<String>,
) -> Result<CommandResult, String> {
    let command = command.trim().to_string();
    if command.is_empty() {
        return Err("命令不能为空".to_string());
    }
    if command.len() > 64 * 1024 {
        return Err("命令过长（超过 64KB）".to_string());
    }
    reject_if_catastrophic(&command)?;

    let cancel = register_cancel(request_id);
    let _guard = cancel.as_ref().map(|(id, _)| CancelGuard(id.clone()));

    let handle = session_handle(&app, &session_id).await?;
    exec_collect(
        &handle,
        &command,
        timeout_secs.unwrap_or(DEFAULT_TIMEOUT_SECS),
        cancel.as_ref().map(|(_, flag)| flag),
    )
    .await
}

/// 把脚本内容写到远程服务器并 chmod 755（Agent 工具 `write_script` 的后端实现）
#[tauri::command]
pub async fn agent_write_script(
    app: AppHandle,
    session_id: String,
    path: String,
    content: String,
    execute: Option<bool>,
    timeout_secs: Option<u64>,
    request_id: Option<String>,
) -> Result<WriteScriptResult, String> {
    let path = path.trim().to_string();
    if path.is_empty() {
        return Err("脚本路径不能为空".to_string());
    }
    if path.len() > 4096 || path.contains('\0') {
        return Err("脚本路径非法".to_string());
    }
    if path.ends_with('/') {
        return Err("脚本路径不能以 / 结尾".to_string());
    }
    if content.len() > MAX_SCRIPT_BYTES {
        return Err(format!(
            "脚本内容过大（{}KB，上限 {}KB）",
            content.len() / 1024,
            MAX_SCRIPT_BYTES / 1024
        ));
    }
    if execute.unwrap_or(false) {
        reject_if_catastrophic(&content)?;
    }

    let cancel = register_cancel(request_id);
    let _guard = cancel.as_ref().map(|(id, _)| CancelGuard(id.clone()));
    let cancel_flag = cancel.as_ref().map(|(_, flag)| flag);

    let state = app.state::<AppState>();
    let sftp = crate::sftp::open_sftp(&state, &session_id).await?;

    // 相对路径 / ~ 相对家目录解析成绝对路径，避免依赖服务端 cwd 的差异
    let resolved = if path.starts_with('/') {
        crate::sftp::normalize_remote_path(&path)
    } else if let Some(rest) = path.strip_prefix("~/") {
        let home = sftp
            .canonicalize(".")
            .await
            .map_err(|e| format!("获取家目录失败：{e}"))?;
        crate::sftp::normalize_remote_path(&format!("{home}/{rest}"))
    } else {
        let home = sftp
            .canonicalize(".")
            .await
            .map_err(|e| format!("获取家目录失败：{e}"))?;
        crate::sftp::normalize_remote_path(&format!("{home}/{path}"))
    };

    // 创建父目录
    if let Some((dir, _)) = resolved.rsplit_once('/') {
        ensure_remote_dir(&sftp, dir).await?;
    }

    let mut file = sftp
        .open_with_flags(
            &resolved,
            OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::TRUNCATE,
        )
        .await
        .map_err(|e| format!("打开远程文件失败：{e}"))?;
    tokio::time::timeout(Duration::from_secs(30), async {
        file.write_all(content.as_bytes())
            .await
            .map_err(|e| format!("写入远程文件失败：{e}"))?;
        file.close()
            .await
            .map_err(|e| format!("关闭远程文件失败：{e}"))
    })
    .await
    .map_err(|_| "写入脚本超时（30 秒）".to_string())??;
    // SFTP 通道用完即关，避免长期占用服务端会话数
    drop(sftp);

    // 通过 exec 设置可执行权限（SFTP setstat 在不同服务端实现上兼容性参差）
    let chmod_cmd = format!(
        "chmod 755 -- {} 2>&1",
        shell_quote(&resolved)
    );
    let handle = session_handle(&app, &session_id).await?;
    let chmod = exec_collect(&handle, &chmod_cmd, 15, cancel_flag).await?;
    if chmod.exit_code != 0 {
        return Err(format!(
            "脚本已写入 {resolved}，但设置可执行权限失败（退出码 {}）：{}",
            chmod.exit_code,
            chmod.stdout.trim()
        ));
    }

    let exec = if execute.unwrap_or(false) {
        let run_cmd = format!("{} 2>&1", shell_quote(&resolved));
        let timeout = timeout_secs.unwrap_or(DEFAULT_TIMEOUT_SECS);
        Some(exec_collect(&handle, &run_cmd, timeout, cancel_flag).await?)
    } else {
        None
    };

    Ok(WriteScriptResult {
        path: resolved,
        bytes: content.len(),
        mode: "755".to_string(),
        exec,
    })
}

/// 递归创建远程目录（父目录必须逐级创建）
async fn ensure_remote_dir(
    sftp: &russh_sftp::client::SftpSession,
    dir: &str,
) -> Result<(), String> {
    if dir.is_empty() || dir == "/" {
        return Ok(());
    }
    let mut cur = String::new();
    for seg in dir.split('/').filter(|s| !s.is_empty()) {
        cur.push('/');
        cur.push_str(seg);
        match sftp.metadata(&cur).await {
            Ok(_) => continue,
            Err(e) if crate::sftp::is_not_found(&e) => {
                if let Err(create_err) = sftp.create_dir(&cur).await {
                    // check-then-act：并发创建同名目录时 EEXIST 不是错误
                    if sftp.metadata(&cur).await.is_err() {
                        return Err(format!("创建远程目录 {cur} 失败：{create_err}"));
                    }
                }
            }
            Err(e) => return Err(format!("读取远程目录 {cur} 失败：{e}")),
        }
    }
    Ok(())
}

/// 把字符串安全地包成单个 shell 参数（单引号转义，换行/反引号/$ 都不会被解释）
fn shell_quote(s: &str) -> String {
    if s.is_empty() {
        return "''".to_string();
    }
    // 只由安全字符构成时可以不加引号，便于阅读
    if s.chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '.' | '_' | '-' | ':' | '@' | '+'))
    {
        return s.to_string();
    }
    format!("'{}'", s.replace('\'', r"'\''"))
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---------- 工具定义：模型契约 ----------

    #[test]
    fn tool_definitions_are_well_formed() {
        let tools = tool_definitions();
        let arr = tools.as_array().expect("工具定义必须是数组");
        assert_eq!(arr.len(), 2);
        let names: Vec<&str> = arr
            .iter()
            .map(|t| t["function"]["name"].as_str().unwrap())
            .collect();
        assert!(names.contains(&"run_command"));
        assert!(names.contains(&"write_script"));
        for t in arr {
            assert_eq!(t["type"], "function");
            assert!(t["function"]["description"].as_str().unwrap().len() > 20);
            assert_eq!(t["function"]["parameters"]["type"], "object");
            assert!(
                t["function"]["parameters"]["required"].is_array(),
                "每个工具都必须声明必填参数"
            );
        }
    }

    // ---------- 高危命令拦截 ----------

    #[test]
    fn blocks_catastrophic_commands() {
        for cmd in [
            "rm -rf /",
            "rm -rf /*",
            "sudo rm -rf /",
            "/bin/rm -fr /",
            "echo hi; rm -rf /",
            "rm -Rf ~",
            "mkfs.ext4 /dev/sda1",
            "dd if=/dev/zero of=/dev/sda bs=1M",
            "shutdown -h now",
            "reboot",
            "init 0",
            ":(){ :|:& };:",
            "chmod -R 777 /",
        ] {
            assert!(
                catastrophic_reason(cmd).is_some(),
                "应当拦截：{cmd}"
            );
        }
    }

    #[test]
    fn allows_normal_operations() {
        for cmd in [
            "rm -rf /tmp/build",
            "rm -rf /var/log/myapp/*",
            "rm -f /tmp/a.txt",
            "df -h",
            "systemctl restart nginx",
            "chmod +x /home/u/check.sh",
            "chmod -R 755 /var/www/html",
            "ls -la ~",
            "cat /etc/os-release",
            "dd if=/dev/sda of=/tmp/mbr.bin bs=512 count=1",
        ] {
            assert!(
                catastrophic_reason(cmd).is_none(),
                "不应拦截：{cmd}"
            );
        }
    }

    #[test]
    fn catastrophic_check_is_case_insensitive_and_handles_whitespace() {
        assert!(catastrophic_reason("RM -RF /").is_some());
        assert!(catastrophic_reason("rm   -rf   /").is_some());
        assert!(catastrophic_reason("rm -rf / && echo done").is_some());
    }

    // ---------- shell 引号 ----------

    #[test]
    fn shell_quote_keeps_safe_paths_bare() {
        assert_eq!(shell_quote("/home/u/check.sh"), "/home/u/check.sh");
        assert_eq!(shell_quote("a-b_c.d"), "a-b_c.d");
    }

    #[test]
    fn shell_quote_escapes_dangerous_characters() {
        assert_eq!(shell_quote("/tmp/a b.sh"), "'/tmp/a b.sh'");
        assert_eq!(shell_quote("/tmp/it's.sh"), r"'/tmp/it'\''s.sh'");
        assert_eq!(shell_quote("$(rm -rf /)"), "'$(rm -rf /)'");
        assert_eq!(shell_quote("a;b"), "'a;b'");
        assert_eq!(shell_quote(""), "''");
    }

    #[test]
    fn shell_quote_roundtrip_never_leaves_unquoted_metacharacters() {
        for s in [
            "a b",
            "a'b",
            "a\"b",
            "a`id`b",
            "a$HOME",
            "a\nb",
            "a&b",
            "a|b",
            "a>b",
            "a(b)",
        ] {
            let q = shell_quote(s);
            assert!(
                q.starts_with('\'') && q.ends_with('\''),
                "含特殊字符的参数必须整体加单引号：{s} -> {q}"
            );
        }
    }

    // ---------- 取消标志注册表 ----------

    #[tokio::test]
    async fn agent_cancel_sets_registered_flag() {
        let (id, flag) = register_cancel(Some("agent-req-live".into())).expect("应能注册");
        assert!(!flag.load(Ordering::Relaxed));
        agent_cancel(id.clone()).await.unwrap();
        assert!(flag.load(Ordering::Relaxed), "取消标志应当被置位");
        drop(CancelGuard(id));
    }

    #[tokio::test]
    async fn agent_cancel_is_idempotent_for_unknown_request() {
        agent_cancel("agent-never-existed".into()).await.unwrap();
        agent_cancel("agent-never-existed".into()).await.unwrap();
    }

    #[tokio::test]
    async fn cancel_guard_removes_entry_on_drop() {
        let (id, _flag) = register_cancel(Some("agent-req-guard".into())).expect("应能注册");
        assert!(cancel_flags()
            .lock()
            .unwrap()
            .contains_key("agent-req-guard"));
        drop(CancelGuard(id));
        assert!(
            !cancel_flags()
                .lock()
                .unwrap()
                .contains_key("agent-req-guard"),
            "Drop 之后条目必须被摘除"
        );
    }

    #[test]
    fn register_cancel_without_request_id_is_disabled() {
        // 不传 request_id 时命令仍然可执行，只是无法被「停止」
        assert!(register_cancel(None).is_none());
    }
}
