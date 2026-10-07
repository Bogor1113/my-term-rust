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
    let client = Client::builder()
        .timeout(Duration::from_secs(300))
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
    {
        let mut flags = cancel_flags().lock().unwrap();
        flags.insert(request_id.clone(), cancel_flag.clone());
    }

    // 逐行解析 SSE 流：data: {...}，累计增量内容。
    // 用内层 async 块包裹：无论正常结束还是中途出错返回，取消标志都保证被移除，
    // 结束事件都保证发出（前端已分离监听时事件被自动忽略）。
    let result = async {
        let mut stream = resp.bytes_stream();
        let mut buffer = String::new();
        while let Some(chunk) = stream.next().await {
            if cancel_flag.load(Ordering::Relaxed) {
                break; // 用户主动停止生成
            }
            let bytes = chunk.map_err(|e| format!("读取响应流失败：{e}"))?;
            buffer.push_str(&String::from_utf8_lossy(&bytes));
            while let Some(pos) = buffer.find('\n') {
                let line = buffer[..pos].trim().to_string();
                buffer = buffer[pos + 1..].to_string();
                if let Some(data) = line.strip_prefix("data:") {
                    let data = data.trim();
                    if data == "[DONE]" {
                        continue;
                    }
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(data) {
                        if let Some(delta) = v["choices"][0]["delta"]["content"].as_str() {
                            if !delta.is_empty() {
                                let _ =
                                    app.emit(&format!("ai-chunk-{request_id}"), delta.to_string());
                            }
                        }
                    }
                }
            }
        }
        Ok(())
    }
    .await;

    // 清理注册表并广播结束事件
    {
        let mut flags = cancel_flags().lock().unwrap();
        flags.remove(&request_id);
    }
    let _ = app.emit(&format!("ai-done-{request_id}"), ());
    result
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
    if let Some(flag) = cancel_flags().lock().unwrap().get(&request_id) {
        flag.store(true, Ordering::Relaxed);
    }
    Ok(())
}
