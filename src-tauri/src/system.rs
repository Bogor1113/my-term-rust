//! 远程系统资源监控模块
//!
//! 每个已连接的 SSH 会话会启动一个后台 tokio 任务，每 ~2 秒通过 exec 通道
//! 在远程服务器上执行 shell 命令采集 CPU / 内存 / 网络 / 磁盘数据，
//! 解析后通过 `session-sys-info-<session_id>` 事件推送给前端。

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager, State};

use crate::AppState;

/// 远程 Linux 系统的一次采样结果
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteSysInfo {
    pub session_id: String,
    pub host: String,
    pub cpu_percent: f64,
    pub cpu_brand: String,
    pub mem_total: u64,
    pub mem_used: u64,
    pub mem_percent: f64,
    /// 下行速率（字节/秒）
    pub net_rx: f64,
    /// 上行速率（字节/秒）
    pub net_tx: f64,
    pub disks: Vec<RemoteDiskInfo>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteDiskInfo {
    pub name: String,
    pub total: u64,
    pub available: u64,
    pub percent: f64,
}

/// 在远程服务器上执行命令并返回全部输出（独立通道，不影响其它通道）
/// 整体带 20s 超时：监控采集命令若在远端挂死（磁盘 IO 卡住 / shell 初始化
/// 卡住），不能永久阻塞——超时返回 Err，由调用方的连续失败退出机制接管。
async fn exec_remote(
    handle_arc: &Arc<tokio::sync::Mutex<russh::client::Handle<crate::ssh::Client>>>,
    cmd: &str,
) -> Result<String, String> {
    use russh::ChannelMsg;

    let inner = async {
        let mut channel = {
            let handle = handle_arc.lock().await;
            let chan = handle
                .channel_open_session()
                .await
                .map_err(|e| format!("打开通道失败：{e}"))?;
            chan.exec(true, cmd.as_bytes())
                .await
                .map_err(|e| format!("执行命令失败：{e}"))?;
            chan
        };

        let mut output_buf = Vec::new();
        loop {
            match channel.wait().await {
                Some(ChannelMsg::Data { data }) => {
                    output_buf.extend_from_slice(&data);
                }
                Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => break,
                Some(_) => {}
            }
        }
        Ok::<String, String>(String::from_utf8_lossy(&output_buf).into_owned())
    };

    // 采集命令内含 1s sleep，正常耗时 <5s；20s 足够覆盖慢机器
    tokio::time::timeout(Duration::from_secs(20), inner)
        .await
        .map_err(|_| "远程命令执行超时".to_string())?
}

/// 在远程服务器上采集一次系统数据
/// 通过 exec 通道运行 shell 命令并解析输出
///
/// `os_cache` 由调用方（监控循环）持有并跨轮复用：远端 OS 类型不会变，
/// 缓存后首轮之后不必再探测。
async fn collect_remote_stats(
    app: &AppHandle,
    session_id: &str,
    os_cache: &mut Option<String>,
) -> Result<RemoteSysInfo, String> {
    // 获取会话连接：仅快速克隆句柄 Arc 与 host，随即释放全局 sessions 锁。
    // 网络操作（打开通道 / exec）在锁外进行，避免监控每 ~3 秒阻塞所有
    // send_input / resize / SFTP 等需要全局锁的命令。
    let (handle_arc, host) = {
        let state = app.state::<AppState>();
        let sessions = state.sessions.lock().await;
        let conn = sessions
            .get(session_id)
            .ok_or_else(|| "会话不存在".to_string())?;
        (conn.handle.clone(), conn.host.clone())
    };

    // 先探测操作系统：/proc 监控仅适用于 Linux，
    // macOS 使用 top / vm_stat / netstat，其它系统优雅降级（不崩溃）。
    //
    // 结果按会话缓存（os_cache）：uname 不会变，而原先每一轮采集都探测一次
    // —— 等于每 3 秒多开一个 exec 通道 + 一次完整 SSH 往返，纯浪费。
    let os = match os_cache.as_deref() {
        Some(cached) if !cached.is_empty() => cached.to_string(),
        _ => {
            let probed = exec_remote(&handle_arc, "uname -s 2>/dev/null")
                .await?
                .trim()
                .to_string();
            *os_cache = Some(probed.clone());
            probed
        }
    };

    // 采集命令：两次采样以计算 CPU/网络差分
    let cmd = if os == "Linux" {
        r#"
echo "---CPU1---"
cat /proc/stat 2>/dev/null | head -1
echo "---NET1---"
cat /proc/net/dev 2>/dev/null | awk 'NR>2 {r+=$2; t+=$10} END {print r,t}'
echo "---SLEEP---"
sleep 1
echo "---CPU2---"
cat /proc/stat 2>/dev/null | head -1
echo "---NET2---"
cat /proc/net/dev 2>/dev/null | awk 'NR>2 {r+=$2; t+=$10} END {print r,t}'
echo "---MEM---"
free -b 2>/dev/null | awk '/^Mem:/ {printf "total=%s used=%s avail=%s\n",$2,$3,$7}'
echo "---CPUINFO---"
cat /proc/cpuinfo 2>/dev/null | grep "model name" | head -1 | cut -d: -f2- | sed 's/^ *//'
echo "---DSK---"
df -B1 2>/dev/null | awk 'NR>1 {print $1,$2,$3,$4,$5,$6}'
echo "---DONE---"
"#
    } else if os == "Darwin" {
        // macOS：top / vm_stat / netstat -ib 采集，格式与 Linux 不同
        r#"
echo "---CPU1---"
top -l 1 -n 0 2>/dev/null | grep "^CPU usage"
echo "---NET1---"
netstat -ib 2>/dev/null | awk '$1 ~ /^en/ && $3 ~ /^[0-9]+/ {r+=$7; t+=$10} END {print r+0, t+0}'
echo "---SLEEP---"
sleep 1
echo "---CPU2---"
top -l 1 -n 0 2>/dev/null | grep "^CPU usage"
echo "---NET2---"
netstat -ib 2>/dev/null | awk '$1 ~ /^en/ && $3 ~ /^[0-9]+/ {r+=$7; t+=$10} END {print r+0, t+0}'
echo "---MEM---"
top -l 1 -n 0 2>/dev/null | grep "^PhysMem"
echo "---CPUINFO---"
sysctl -n machdep.cpu.brand_string 2>/dev/null
echo "---DSK---"
df -B1 2>/dev/null | awk 'NR>1 {print $1,$2,$3,$4,$5,$6}'
echo "---DONE---"
"#
    } else {
        // 其它系统：不支持，返回空数据（优雅降级，不崩溃）
        return Ok(RemoteSysInfo {
            session_id: session_id.to_string(),
            host,
            cpu_percent: 0.0,
            cpu_brand: format!("不支持（{os}）"),
            mem_total: 0,
            mem_used: 0,
            mem_percent: 0.0,
            net_rx: 0.0,
            net_tx: 0.0,
            disks: vec![],
        });
    };

    let text = exec_remote(&handle_arc, cmd).await?;
    if os == "Darwin" {
        parse_stats_macos(&text, &host, session_id)
    } else {
        parse_stats(&text, &host, session_id)
    }
}

/// 解析 macOS 采集输出（top / vm_stat / netstat / df）
fn parse_stats_macos(text: &str, host: &str, session_id: &str) -> Result<RemoteSysInfo, String> {
    let sections = split_sections(text);

    // CPU：top 输出 "CPU usage: x% user, y% sys, z% idle"
    let parse_cpu_idle = |section: &str| -> Option<f64> {
        let block = sections.get(section)?;
        let line = block.lines().find(|l| l.contains("CPU usage"))?;
        line.split(',').find_map(|p| {
            let p = p.trim();
            p.strip_suffix("% idle")
                .and_then(|v| v.trim().parse::<f64>().ok())
        })
    };
    let cpu1_idle = parse_cpu_idle("CPU1").unwrap_or(100.0);
    let cpu2_idle = parse_cpu_idle("CPU2").unwrap_or(100.0);
    // 取后一次采样计算使用率；两次都失败则视为 0
    let cpu_percent = if cpu2_idle < 100.0 || cpu1_idle < 100.0 {
        (100.0 - cpu2_idle).clamp(0.0, 100.0)
    } else {
        0.0
    };

    // 内存：top 输出 "PhysMem: 15G used (4255M wired), 17G unused."
    let parse_bytes = |s: &str| -> Option<u64> {
        let s = s.trim();
        if let Some(v) = s.strip_suffix('G') {
            v.parse::<f64>().ok().map(|x| (x * 1_073_741_824.0) as u64)
        } else if let Some(v) = s.strip_suffix('M') {
            v.parse::<f64>().ok().map(|x| (x * 1_048_576.0) as u64)
        } else if let Some(v) = s.strip_suffix('K') {
            v.parse::<f64>().ok().map(|x| (x * 1024.0) as u64)
        } else {
            s.parse::<u64>().ok()
        }
    };
    let (mem_total, mem_used) = sections
        .get("MEM")
        .and_then(|block| {
            let line = block.lines().find(|l| l.contains("PhysMem"))?;
            // "PhysMem: 15G used (4255M wired), 17G unused."
            let used_part = line.split('(').next()?;
            let used_str = used_part.split_whitespace().nth(1)?;
            let unused_part = line.split(',').nth(1)?;
            let unused_str = unused_part.split_whitespace().nth(1)?;
            let used = parse_bytes(used_str)?;
            let unused = parse_bytes(unused_str)?;
            Some((used + unused, used))
        })
        .unwrap_or((0, 0));
    let mem_percent = if mem_total > 0 {
        mem_used as f64 / mem_total as f64 * 100.0
    } else {
        0.0
    };

    // 网络：与 Linux 相同的两段差分解析
    let parse_net = |section: &str| -> Option<(f64, f64)> {
        let block = sections.get(section)?;
        let line = block.lines().next()?;
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() < 2 {
            return None;
        }
        let rx: f64 = parts[0].parse().ok()?;
        let tx: f64 = parts[1].parse().ok()?;
        Some((rx, tx))
    };
    let net1 = parse_net("NET1").unwrap_or((0.0, 0.0));
    let net2 = parse_net("NET2").unwrap_or((0.0, 0.0));
    let net_rx = (net2.0 - net1.0).max(0.0);
    let net_tx = (net2.1 - net1.1).max(0.0);

    // 磁盘：与 Linux 相同的 df -B1 解析
    let disks = parse_disks(sections.get("DSK"));

    Ok(RemoteSysInfo {
        session_id: session_id.to_string(),
        host: host.to_string(),
        cpu_percent,
        cpu_brand: sections
            .get("CPUINFO")
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "未知".to_string()),
        mem_total,
        mem_used,
        mem_percent,
        net_rx,
        net_tx,
        disks,
    })
}

/// 将 `---TAG---` 标记的输出切分为命名字段
fn split_sections(text: &str) -> HashMap<&str, String> {
    let mut sections: HashMap<&str, String> = HashMap::new();
    let mut current_section = "";
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("---") && trimmed.ends_with("---") {
            let name = &trimmed[3..trimmed.len() - 3];
            if name != "DONE" && name != "SLEEP" {
                current_section = name;
            }
            continue;
        }
        if !current_section.is_empty() {
            sections
                .entry(current_section)
                .or_default()
                .push_str(trimmed);
            sections.entry(current_section).or_default().push('\n');
        }
    }
    sections
}

/// 解析 Linux 远程命令输出（/proc/stat, /proc/net/dev, free, df）
fn parse_stats(text: &str, host: &str, session_id: &str) -> Result<RemoteSysInfo, String> {
    let sections = split_sections(text);

    // 解析 CPU1 / CPU2
    let parse_cpu = |section: &str| -> Option<(u64, u64)> {
        let block = sections.get(section)?;
        let line = block.lines().next()?;
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() < 5 || parts[0] != "cpu" {
            return None;
        }
        let total: u64 = parts[1..].iter().filter_map(|s| s.parse::<u64>().ok()).sum();
        let idle: u64 = parts[4].parse().ok()?;
        Some((total, idle))
    };

    let cpu1 = parse_cpu("CPU1").unwrap_or((0, 0));
    let cpu2 = parse_cpu("CPU2").unwrap_or((0, 0));

    let cpu_percent = if cpu2.0 > cpu1.0 {
        let total_delta = cpu2.0.saturating_sub(cpu1.0) as f64;
        let idle_delta = cpu2.1.saturating_sub(cpu1.1) as f64;
        if total_delta > 0.0 {
            (1.0 - idle_delta / total_delta) * 100.0
        } else {
            0.0
        }
    } else {
        0.0
    };

    // CPU 品牌
    let cpu_brand = sections
        .get("CPUINFO")
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "未知".to_string());

    // 网络 NET1 / NET2
    let parse_net = |section: &str| -> Option<(f64, f64)> {
        let block = sections.get(section)?;
        let line = block.lines().next()?;
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() < 2 {
            return None;
        }
        let rx: f64 = parts[0].parse().ok()?;
        let tx: f64 = parts[1].parse().ok()?;
        Some((rx, tx))
    };

    let net1 = parse_net("NET1").unwrap_or((0.0, 0.0));
    let net2 = parse_net("NET2").unwrap_or((0.0, 0.0));
    // sleep 1 秒 ⇒ interval ~1.0s
    let net_rx = (net2.0 - net1.0).max(0.0);
    let net_tx = (net2.1 - net1.1).max(0.0);

    // 内存
    let (mem_total, mem_used) = sections
        .get("MEM")
        .and_then(|block| {
            let line = block.lines().next()?;
            let mut total = 0u64;
            let mut used = 0u64;
            for part in line.split_whitespace() {
                if let Some(val) = part.strip_prefix("total=") {
                    total = val.parse().ok()?;
                } else if let Some(val) = part.strip_prefix("used=") {
                    used = val.parse().ok()?;
                }
            }
            Some((total, used))
        })
        .unwrap_or((0, 0));

    let mem_percent = if mem_total > 0 {
        mem_used as f64 / mem_total as f64 * 100.0
    } else {
        0.0
    };

    // 磁盘
    let disks = parse_disks(sections.get("DSK"));

    Ok(RemoteSysInfo {
        session_id: session_id.to_string(),
        host: host.to_string(),
        cpu_percent,
        cpu_brand,
        mem_total,
        mem_used,
        mem_percent,
        net_rx,
        net_tx,
        disks,
    })
}

/// 解析 df -B1 输出为磁盘列表
fn parse_disks(block: Option<&String>) -> Vec<RemoteDiskInfo> {
    let Some(block) = block else { return vec![] };
    block
        .lines()
        .filter(|line| {
            let parts: Vec<&str> = line.split_whitespace().collect();
            parts.len() >= 5
                && !parts[0].starts_with("tmpfs")
                && !parts[0].starts_with("devtmpfs")
                && !parts[0].starts_with("overlay")
                && !parts[0].starts_with("squashfs")
                && !parts[0].contains("/loop")
        })
        .filter_map(|line| {
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() < 5 {
                return None;
            }
            let total: u64 = parts[1].parse().ok()?;
            let used: u64 = parts[2].parse().ok()?;
            let available: u64 = parts[3].parse().ok()?;
            let name = if parts[0].starts_with('/') {
                // extract mount point (last column)
                let mount = parts.last()?;
                mount.to_string()
            } else {
                parts[0].to_string()
            };
            Some(RemoteDiskInfo {
                name,
                total,
                available,
                percent: if total > 0 {
                    used as f64 / total as f64 * 100.0
                } else {
                    0.0
                },
            })
        })
        .collect()
}

/// 启动一个会话的远程监控任务
pub fn start_session_monitor(app: &AppHandle, session_id: &str, mut cancel_rx: tokio::sync::watch::Receiver<bool>) {
    let app = app.clone();
    let sid = session_id.to_string();
    tauri::async_runtime::spawn(async move {
        // 等待少量时间让连接稳定
        tokio::time::sleep(Duration::from_millis(500)).await;

        // 连续采集失败达到该次数才停止监控：单次失败（如瞬时网络抖动、
        // exec 通道偶发错误）不终止监控。会话真正断开时由 disconnect_ssh
        // 经 cancel 通道取消本任务，此处仅在异常情况下兜底退出，避免空转。
        let mut consecutive_failures: u32 = 0;
        const MAX_CONSECUTIVE_FAILURES: u32 = 5;
        // 远端 OS 探测结果缓存：uname 不会变，只探一次（见 collect_remote_stats）
        let mut os_cache: Option<String> = None;

        loop {
            // 检查是否应取消（borrow_and_update 同时把当前值标记为已读，
            // 使后续 changed() 只在有真正的新值发送时才被唤醒）
            if *cancel_rx.borrow_and_update() {
                break;
            }

            // 只在「前端正在查看本会话」时才采集。
            // 非活跃会话的资源曲线没有任何订阅者，原先却在每 ~3 秒打一轮 SSH
            // （探测 OS + 采集，2 个 exec 通道），纯属空转。
            // 这里用软开关：不采集时该任务只剩每 2 秒醒一次 + 一次 mutex 取值，
            // 几乎零成本，且前端万一没调用 set_monitor_session 也不会回归成
            // 「监控完全不工作」。
            let is_viewed = {
                let app_state = app.state::<AppState>();
                let current = app_state.monitor_visible.lock().await;
                current.as_deref() == Some(sid.as_str())
            };

            if is_viewed {
                // 采集一次远程数据
                match collect_remote_stats(&app, &sid, &mut os_cache).await {
                    Ok(info) => {
                        consecutive_failures = 0;
                        let _ = app.emit(&format!("session-sys-info-{sid}"), &info);
                    }
                    Err(e) => {
                        eprintln!("[monitor-{sid}] 采集失败：{e}");
                        consecutive_failures += 1;
                        if consecutive_failures >= MAX_CONSECUTIVE_FAILURES {
                            // 连续多次失败，连接大概率已断开，停止监控
                            break;
                        }
                    }
                }
            }

            // 等待下一次采样；取消信号经 watch 通道事件驱动，
            // 取代原先每 100ms 一次的忙轮询
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_secs(2)) => {}
                _ = cancel_rx.changed() => {
                    if *cancel_rx.borrow_and_update() {
                        break;
                    }
                }
            }
        }

        // 任务退出时从全局 map 移除本会话的取消信号发送端，避免残留造成内存泄漏
        let state = app.state::<AppState>();
        state.monitor_cancels.lock().await.remove(&sid);
    });
}

/// 停止会话的远程监控（由外部发送取消信号）
pub async fn stop_session_monitor(state: &State<'_, AppState>, session_id: &str) {
    let mut cancels = state.monitor_cancels.lock().await;
    if let Some(tx) = cancels.remove(session_id) {
        let _ = tx.send(true);
    }
}

/// 设置「前端底部状态条当前正在查看的会话」，只有它会真正采集远程资源数据。
///
/// 由前端在切换标签 / 切换活跃会话时调用，传 `null` 表示当前无会话需要采集。
/// 这是软开关：监控任务本身仍在跑（等取消信号），只是不再打 SSH —— 因此
/// 即便前端漏调用，也只是回到「所有会话都采集」的旧行为，不会出现监控失效。
#[tauri::command]
pub async fn set_monitor_session(
    state: State<'_, AppState>,
    session_id: Option<String>,
) -> Result<(), String> {
    *state.monitor_visible.lock().await = session_id;
    Ok(())
}