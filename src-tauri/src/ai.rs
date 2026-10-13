//! AI 模块：通过 OpenAI 兼容接口调用大模型，流式返回结果
//!
//! 兼容 OpenAI / DeepSeek / Qwen / GLM 等绝大多数服务：配置 BaseURL + API Key + 模型名。
//! 请求由后端 Rust 发出，避免浏览器 CORS 限制与 API Key 暴露在前端包中。

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use futures::StreamExt;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

/// 一条对话消息
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AiMessage {
    pub role: String,
    pub content: String,
}

/// 模型调用配置（BaseURL + API Key + 模型名，可选温度/最大 token）
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AiConfig {
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    pub temperature: Option<f32>,
    pub max_tokens: Option<u32>,
}

/// 截断错误信息（防止超长响应体刷屏）
fn truncate(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        s.to_string()
    } else {
        s.chars().take(n).collect()
    }
}

/// 流式对话：通过 Tauri 事件 ai-chunk-<request_id> 逐段推送增量内容，
/// 结束后发送 ai-done-<request_id>。前端监听这两个事件拼接完整回答。
#[tauri::command]
pub async fn ai_chat_stream(
    app: AppHandle,
    request_id: String,
    config: AiConfig,
    messages: Vec<AiMessage>,
) -> Result<(), String> {
    // 超时拆分：connect_timeout 只管建连，总超时会连带掐断**正在进行的流式输出**，
    // 导致长回答在 5 分钟被硬切并报"请求中断"。这里给建连 30 秒、且不设总超时，
    // 由取消标志 + 读取循环负责终止。
    let client = Client::builder()
        .connect_timeout(Duration::from_secs(30))
        .pool_idle_timeout(Duration::from_secs(90))
        .build()
        .map_err(|e| format!("初始化请求客户端失败：{e}"))?;

    let base = config.base_url.trim().trim_end_matches('/');
    let url = if base.ends_with("/chat/completions") {
        base.to_string()
    } else {
        format!("{base}/chat/completions")
    };

    let mut body = serde_json::json!({
        "model": config.model,
        "messages": messages,
        "stream": true,
    });
    if let Some(t) = config.temperature {
        body["temperature"] = serde_json::json!(t);
    }
    if let Some(m) = config.max_tokens {
        body["max_tokens"] = serde_json::json!(m);
    }

    let resp = client
        .post(&url)
        .bearer_auth(config.api_key)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("请求失败：{e}"))?;

    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("HTTP {status}: {}", truncate(&text, 600)));
    }

    // 注册取消标志：前端调用 ai_chat_cancel 置位后，流读取循环在下一个数据块处退出。
    // 仅在短临界区内持锁（插入/移除），绝不跨 await 持锁。
    let cancel_flag = Arc::new(AtomicBool::new(false));
    // 守卫在整个函数作用域内保持武装（含下面所有 await）：
    // future 被取消时 Drop 会自动清理条目。
    let _cleanup = CancelGuard(request_id.clone());
    {
        // 用 into_inner 兜住 poison：否则任意一次 panic 之后整个 AI 功能
        // （每个入口都要拿这把锁）会永久性地被锁死。
        let mut flags = cancel_flags().lock().unwrap_or_else(|e| e.into_inner());
        flags.insert(request_id.clone(), cancel_flag.clone());
    }

    // 逐行解析 SSE 流：data: {...}，累计增量内容。
    // 用内层 async 块包裹：无论正常结束还是中途出错返回，取消标志都保证被移除，
    // 结束事件都保证发出（前端已分离监听时事件被自动忽略）。
    // 上限保护：某些网关会在流里吐出超长单行（无换行），没有这个闸门 buffer 会无限增长。
    const MAX_SSE_LINE: usize = 8 * 1024 * 1024;
    let result = async {
        let mut stream = resp.bytes_stream();
        // 以字节而非 String 累积：SSE 的 chunk 边界是任意字节位置，用
        // from_utf8_lossy 逐块解码会把跨块的中文字符（也就是本应用的主要
        // 输出内容）永久损坏成 U+FFFD。必须先按字节拼行，再整行解码。
        let mut buffer: Vec<u8> = Vec::new();
        while let Some(chunk) = stream.next().await {
            if cancel_flag.load(Ordering::Relaxed) {
                break; // 用户主动停止生成
            }
            let bytes = chunk.map_err(|e| format!("读取响应流失败：{e}"))?;
            buffer.extend_from_slice(&bytes);
            while let Some(pos) = buffer.iter().position(|&b| b == b'\n') {
                let line = String::from_utf8_lossy(&buffer[..pos]).trim().to_string();
                buffer.drain(..pos + 1);
                if let Some(data) = line.strip_prefix("data:") {
                    let data = data.trim();
                    if data == "[DONE]" {
                        // 终止整个流。原先是 continue，会一直读到服务端关连接为止 ——
                        // 对保持 keep-alive 的实现而言就是无限期挂起。
                        return Ok(());
                    }
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(data) {
                        // 网关常在 HTTP 200 的响应体里返回 {"error": {...}}。
                        // 这种情况下 choices 为空，下面取不到 delta，用户只会看到
                        // 一个空白回复 + ai-done，没有任何错误提示。
                        if let Some(err) = v.get("error").and_then(|e| e.as_str()) {
                            return Err(format!("接口返回错误：{err}"));
                        }
                        if let Some(delta) = v["choices"][0]["delta"]["content"].as_str() {
                            if !delta.is_empty() {
                                let _ =
                                    app.emit(&format!("ai-chunk-{request_id}"), delta.to_string());
                            }
                        }
                    }
                }
            }
            if buffer.len() > MAX_SSE_LINE {
                return Err("响应行过长（超过 8MB），已中止".to_string());
            }
        }
        Ok(())
    }
    .await;

    // _cleanup 在此处随作用域结束而 Drop，负责摘除注册表条目
    let _ = app.emit(&format!("ai-done-{request_id}"), ());
    result
}

/// 请求级清理守卫：无论命令正常返回、返回错误，还是**整个 future 被 drop**
/// （关窗、页面重载、前端中止 invoke），都保证把 request_id 从全局表里摘掉。
///
/// 这不是可有可无的健壮性装饰：正常路径上的移除写在函数末尾，一旦 future
/// 被取消，那几行根本不会执行，Arc<AtomicBool> 与 request_id 字符串就永久
/// 留在表里。反复开关 AI 面板会持续累积。
struct CancelGuard(String);

impl Drop for CancelGuard {
    fn drop(&mut self) {
        // cancel_flags 是 std::sync::Mutex，这里是纯同步临界区，
        // 即使在 runtime 线程上执行也不会阻塞或 panic。
        let mut flags = cancel_flags().lock().unwrap_or_else(|e| e.into_inner());
        flags.remove(&self.0);
    }
}

/// 取消标志注册表：request_id -> 标志位。进程级静态表，请求结束即移除。
fn cancel_flags() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    static FLAGS: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();
    FLAGS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 「停止生成」：置位取消标志，流循环在下一个数据块到达时退出并断开上游连接。
/// 请求不存在（已完成/从未发起）时静默成功，幂等安全。
#[tauri::command]
pub async fn ai_chat_cancel(request_id: String) -> Result<(), String> {
    if let Some(flag) = cancel_flags()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&request_id)
    {
        flag.store(true, Ordering::Relaxed);
    }
    Ok(())
}
