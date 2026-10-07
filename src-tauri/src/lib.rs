mod ai;
mod cluster;
mod sftp;
mod ssh;
mod system;

use std::collections::HashMap;
use tauri::{LogicalPosition, LogicalSize, Manager};

/// 把主窗口的尺寸与位置限制进**当前显示器的工作区**。
///
/// 起因：配置里默认 1360×860、minHeight 640，而本项目 `decorations: false` ——
/// 最小化/最大化/关闭三个按钮由前端画在窗口右上角。在低分辨率或**高缩放**的机器上
/// （例：1366×768 屏幕 @125% 缩放，逻辑工作区只有约 819×582），窗口既比屏幕大、
/// 最小尺寸也大于可用高度 → 用户既看不到底部、也无法缩小，右上角的关闭按钮可能直接
/// 落到屏幕外点不到。
///
/// 规则：
/// - 目标尺寸 = min(配置期望值, 工作区 × 96%)，保证窗口完整可见；
/// - 最小尺寸同步下调为 min(配置最小值, 目标尺寸)，否则"最小高度 > 屏幕可用高度"会让
///   用户想缩小也缩不动；
/// - 位置在工作区内居中后再夹一次边界，多显示器 / 负坐标（副屏在主屏左侧）也正确；
/// - `work_area` 已排除任务栏，且是物理像素，需除以 scale_factor 换算到逻辑像素。
///
/// 本函数在 `visible: false` 阶段调用（窗口尚未显示），因此用户看不到任何跳动。
fn fit_window_to_work_area<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) {
    let monitor = window
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| window.primary_monitor().ok().flatten());
    let Some(monitor) = monitor else {
        eprintln!("[window-fit] 拿不到显示器信息，跳过窗口适配（沿用配置尺寸）");
        return;
    };

    let scale = monitor.scale_factor().max(0.1);
    let wa = monitor.work_area();
    let wa_w = wa.size.width as f64 / scale;
    let wa_h = wa.size.height as f64 / scale;
    let wa_x = wa.position.x as f64 / scale;
    let wa_y = wa.position.y as f64 / scale;

    // 与 tauri.conf.json 的期望值保持一致
    const WANT_W: f64 = 1360.0;
    const WANT_H: f64 = 860.0;
    const MIN_W: f64 = 960.0;
    const MIN_H: f64 = 640.0;
    // 留边比例：既不贴满屏幕，也不至于太小
    const EDGE: f64 = 0.96;

    let w = (WANT_W.min(wa_w * EDGE)).max(480.0).floor();
    let h = (WANT_H.min(wa_h * EDGE)).max(360.0).floor();

    let _ = window.set_size(tauri::Size::Logical(LogicalSize::new(w, h)));
    // 最小尺寸必须 ≤ 目标尺寸，否则小屏上依然会溢出
    let _ = window.set_min_size(Some(tauri::Size::Logical(LogicalSize::new(
        MIN_W.min(w),
        MIN_H.min(h),
    ))));

    let x = (wa_x + (wa_w - w) / 2.0).clamp(wa_x, (wa_x + wa_w - w).max(wa_x));
    let y = (wa_y + (wa_h - h) / 2.0).clamp(wa_y, (wa_y + wa_h - h).max(wa_y));
    let _ = window.set_position(tauri::Position::Logical(LogicalPosition::new(x, y)));

    eprintln!(
        "[window-fit] 工作区 {:.0}x{:.0} @{:.0},{:.0}（缩放 {:.2}）→ 窗口 {:.0}x{:.0} @{:.0},{:.0}",
        wa_w, wa_h, wa_x, wa_y, scale, w, h, x, y
    );
}
/// 全局应用状态
pub struct AppState {
    pub sessions: tokio::sync::Mutex<HashMap<String, ssh::SshConn>>,
    /// 每个会话的远程监控取消信号发送端
    pub monitor_cancels: tokio::sync::Mutex<HashMap<String, tokio::sync::watch::Sender<bool>>>,
    /// 传输同名冲突等待回复：request_id -> oneshot 发送端
    pub conflict_resolvers:
        tokio::sync::Mutex<HashMap<String, tokio::sync::oneshot::Sender<sftp::ConflictChoice>>>,
    /// 集群服务状态缓存（Hadoop 生态服务检测结果）。
    /// 用 Arc 而非 Mutex：内部缓存/探针各自有独立同步原语，外层加锁反而会让
    /// 长操作（单次检测 8s、启动等待最长 90s）互斥阻塞其他命令。
    pub cluster: std::sync::Arc<cluster::ClusterManager>,
    /// 本地端口转发：session_id -> (local_port -> 转发任务)
    pub forwards:
        tokio::sync::Mutex<HashMap<String, HashMap<u16, ssh::ForwardEntry>>>,
    /// 会话日志配置（开关 + 目录）
    pub session_log: tokio::sync::RwLock<ssh::SessionLogConfig>,
    /// 前端底部状态条当前正在查看的会话 id。
    ///
    /// 只有这一条会话需要真正采集远程资源数据：非活跃会话的资源曲线没有任何
    /// 订阅者，却在每 ~3 秒打一轮 SSH（探测 OS + 采集，2 个 exec 通道），既白耗
    /// 本机 CPU/网络，也给远端服务器增加无谓负载。None = 无需采集。
    /// 与 ClusterPanel「仅在标签激活时轮询」是同一策略。
    pub monitor_visible: tokio::sync::Mutex<Option<String>>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            sessions: tokio::sync::Mutex::new(HashMap::new()),
            monitor_cancels: tokio::sync::Mutex::new(HashMap::new()),
            conflict_resolvers: tokio::sync::Mutex::new(HashMap::new()),
            cluster: std::sync::Arc::new(cluster::ClusterManager::new()),
            forwards: tokio::sync::Mutex::new(HashMap::new()),
            session_log: tokio::sync::RwLock::new(ssh::SessionLogConfig::default()),
            monitor_visible: tokio::sync::Mutex::new(None),
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            ssh::connect_ssh,
            ssh::send_input,
            ssh::resize_pty,
            ssh::disconnect_ssh,
            ssh::list_sessions,
            ssh::forward_add,
            ssh::forward_list,
            ssh::forward_remove,
            ssh::session_recent_output,
            system::set_monitor_session,
            ai::ai_chat_stream,
            ai::ai_chat_cancel,
            sftp::sftp_home,
            sftp::sftp_list,
            sftp::sftp_mkdir,
            sftp::sftp_rename,
            sftp::sftp_remove,
            sftp::sftp_download,
            sftp::sftp_upload,
            sftp::sftp_resolve_conflict,
            cluster::cluster_list_services,
            cluster::cluster_service_action,
            cluster::cluster_service_logs,
            cluster::cluster_web_url,
            cluster::cluster_yarn_apps,
            cluster::cluster_yarn_kill,
            cluster::cluster_hdfs_list,
            cluster::cluster_hdfs_summary,
            cluster::cluster_hdfs_nodes,
            cluster::cluster_yarn_metrics,
            cluster::cluster_yarn_nodes,
            cluster::cluster_namenode_jvm,
        ])
        .setup(|app| {
            // 窗口显示的安全兜底：窗口配置为 visible:false 启动（防白屏），
            // 正常流程由前端 JS 在 150ms 后调用 show()；但若 JS 因任何原因未执行
            // （渲染崩溃、模块加载失败等），窗口将永远隐藏、只剩进程在跑。
            // 这里在 Rust 主进程侧 2.5 秒后强制显示窗口——JS 正常时此调用幂等无害，
            // JS 异常时保证界面必然出现（背景色已由 backgroundColor 兜底为暗色）。
            // 注：xterm 首帧渲染较重，兜底放宽到 2.5s，避免慢机器上抢先于 React 绘制。
            if let Some(win) = app.get_webview_window("main") {
                // 低分辨率 / 高缩放机器适配：此刻窗口仍是 hidden（visible:false），
                // 在它被 show 之前就把尺寸与位置定好，用户看不到任何跳动。
                fit_window_to_work_area(&win);
                let win = win.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(2500));
                    let _ = win.show();
                });
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}