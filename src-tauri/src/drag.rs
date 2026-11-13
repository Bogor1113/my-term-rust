//! 原生拖拽下载（拖出 SFTP 面板 → 拖到桌面/资源管理器任意目录松手即复制）
//!
//! 流程（配合前端 SftpPanel 的手势逻辑）：
//! 1. 用户按住文件/文件夹行拖出面板 → 前端先经 SFTP 把目标下载到本地下载目录；
//! 2. 下载完成时若鼠标仍未松开，前端调用本模块 `drag_out_files`；
//! 3. 本命令通过 crabnebula 的 `drag` crate 启动系统原生 OLE 拖拽
//!    （Windows: DoDragDrop / macOS: NSDraggingSession / Linux: GTK DnD），
//!    之后用户拖到哪个目录松手，目标程序自己完成复制 —— "拖到哪就下载到哪"。
//!
//! 线程模型：start_drag 阻塞至拖拽结束（内部自带模态消息循环），
//! 经 run_on_main_thread 在拥有窗口的主线程执行，期间 UI 正常刷新；
//! 命令侧用 spawn_blocking 等待，不阻塞异步运行时。

use std::path::PathBuf;

/// 单次拖拽的文件数上限：多选拖拽未在 UI 暴露，防御性限制。
const MAX_DRAG_ITEMS: usize = 16;

/// 拖拽预览图标（跟随光标的小图），复用应用自带图标
const PREVIEW_ICON: &[u8] = include_bytes!("../icons/32x32.png");

#[tauri::command]
pub async fn drag_out_files(app: tauri::AppHandle, paths: Vec<String>) -> Result<(), String> {
    eprintln!("[drag-out {}] 收到拖拽请求：{:?}", now_ms(), paths);
    if paths.is_empty() {
        return Err("拖拽列表为空".into());
    }
    if paths.len() > MAX_DRAG_ITEMS {
        return Err(format!("单次最多拖拽 {MAX_DRAG_ITEMS} 项"));
    }
    if paths.iter().any(|p| p.trim().is_empty()) {
        return Err("拖拽路径为空".into());
    }

    let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();
    let app2 = app.clone();
    app.run_on_main_thread(move || {
        let res = run_drag(&paths, &app2);
        eprintln!("[drag-out {}] start_drag 结果：{res:?}", now_ms());
        let _ = tx.send(res);
    })
    .map_err(|e| format!("调度主线程失败：{e}"))?;
    match tauri::async_runtime::spawn_blocking(move || rx.recv()).await {
        Ok(Ok(res)) => res,
        Ok(Err(_)) => Err("拖拽线程异常退出".into()),
        Err(e) => Err(format!("等待拖拽完成失败：{e}")),
    }
}

fn run_drag(paths: &[String], app: &tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "主窗口不存在".to_string())?;
    let files: Vec<PathBuf> = paths.iter().map(PathBuf::from).collect();
    let item = drag::DragItem::Files(files);
    let icon = drag::Image::Raw(PREVIEW_ICON.to_vec());
    let on_drop = |result: drag::DragResult, pos: drag::CursorPosition| {
        eprintln!(
            "[drag-out {}] 拖拽结束：{result:?} cursor=({},{})",
            now_ms(),
            pos.x,
            pos.y
        );
    };
    drag::start_drag(&window, item, icon, on_drop, drag::Options::default())
        .map_err(|e| format!("启动原生拖拽失败：{e}"))
}

fn now_ms() -> u128 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis()
        % 1_000_000
}
