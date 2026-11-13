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

// ---------- Agent（function calling）----------

/// 模型要求调用的一次工具调用
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AgentToolCall {
    /// 工具调用 id，回传 tool 结果时必须原样带回
    pub id: String,
    /// OpenAI 约定固定为 "function"（部分服务端会省略，缺省补上）
    #[serde(rename = "type", default = "function_type")]
    pub kind: String,
    pub function: AgentFunctionCall,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AgentFunctionCall {
    pub name: String,
    #[serde(default)]
    pub arguments: String,
}

fn function_type() -> String {
    "function".to_string()
}

/// Agent 对话中的一条消息。
///
/// 字段名必须与 OpenAI 协议完全一致（`tool_calls` / `tool_call_id` 用下划线），
/// 因此这里**不能**加 `rename_all = "camelCase"`；前端按协议原样传递。
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AgentMessage {
    pub role: String,
    /// 纯文本内容。assistant 发起工具调用时通常为空字符串。
    #[serde(default)]
    pub content: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<AgentToolCall>>,
    /// role = "tool" 时对应的工具调用 id
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
}

/// 一次非流式模型调用的结果（Agent 每轮都用它）
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AgentCompletion {
    pub content: String,
    pub tool_calls: Vec<AgentToolCall>,
    pub finish_reason: Option<String>,
}


/// 截断错误信息（防止超长响应体刷屏）
fn truncate(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        s.to_string()
    } else {
        s.chars().take(n).collect()
    }
}

/// 一行 SSE `data:` 载荷的分类结果。
#[derive(Debug, PartialEq)]
enum SseDataAction {
    /// 一段增量内容，需要推给前端
    Delta(String),
    /// 流正常结束（OpenAI 约定的 `data: [DONE]`）
    Done,
    /// 接口返回错误（已格式化成可直接展示给用户的信息）
    Error(String),
}

/// 把一行 `data:` 后的载荷分类。`None` 表示该行不可处理（空行、非 JSON、
/// 无 delta 的空壳帧等），调用方直接忽略。
///
/// 之所以抽成纯函数：错误判定和增量提取是整条 AI 链路上最容易出错的地方，
/// 而它原先内联在流读取循环里，无法单独测试。
fn classify_sse_data(data: &str) -> Option<SseDataAction> {
    let data = data.trim();
    if data.is_empty() {
        return None;
    }
    if data == "[DONE]" {
        return Some(SseDataAction::Done);
    }
    let v: serde_json::Value = serde_json::from_str(data).ok()?;

    // 网关常在 HTTP 200 的响应体里返回错误。两种形态都要认：
    // - OpenAI / DeepSeek 的 `{"error": {"message": "..."}}` —— error 是**对象**；
    // - 部分服务（含 Ollama 兼容端点）的 `{"error": "..."}` —— error 是字符串。
    // 原先只取 `as_str()`，对象形态会落空：choices 取不到 delta，
    // 于是错误被静默吞掉，用户只得到一个空白回复，不知道发生了什么。
    if let Some(e) = v.get("error") {
        let msg = e
            .get("message")
            .and_then(|m| m.as_str())
            .or_else(|| e.as_str())
            .unwrap_or("未知错误");
        return Some(SseDataAction::Error(format!("接口返回错误：{msg}")));
    }

    v["choices"][0]["delta"]["content"]
        .as_str()
        .filter(|s| !s.is_empty())
        .map(|s| SseDataAction::Delta(s.to_string()))
}

/// 由 BaseURL 拼出 chat/completions 端点。
/// 用户填的 BaseURL 可能已经带 `/chat/completions`（从别的工具抄来的），
/// 若再拼一次就会得到 `/chat/completions/chat/completions`。
fn chat_url(base_url: &str) -> String {
    let base = base_url.trim().trim_end_matches('/');
    if base.ends_with("/chat/completions") {
        base.to_string()
    } else {
        format!("{base}/chat/completions")
    }
}

/// 从错误响应体里取出服务商给的 message。
///
/// 多数 OpenAI 兼容服务返回 `{"error":{"message":"..."}}`，少数直接给
/// `{"error":"..."}`；都取不到才退回原文（截断），避免把整段 JSON 甩给用户。
fn api_error_detail(body: &str) -> String {
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(body) {
        if let Some(e) = v.get("error") {
            if let Some(m) = e.get("message").and_then(|m| m.as_str()) {
                return m.to_string();
            }
            if let Some(m) = e.as_str() {
                return m.to_string();
            }
        }
        if let Some(m) = v.get("message").and_then(|m| m.as_str()) {
            return m.to_string();
        }
    }
    truncate(body, 600)
}

/// 把非 2xx 响应整理成一句人能看懂的错误。
///
/// 429 是最容易撞上的一个：一条 Agent 消息可能连发多轮请求，免费 / 未实名
/// 账号的 RPM 很低。这里把 `Retry-After` 一起带出去，前端据此自动退避重试；
/// 同时保留服务商的原始提示（如"请登录 platform 实名认证"）。
fn http_error_message(status: reqwest::StatusCode, body: &str, retry_after: Option<&str>) -> String {
    let detail = api_error_detail(body);
    if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
        let wait = retry_after.and_then(|s| s.trim().parse::<u64>().ok());
        let hint = match wait {
            Some(s) => format!("，请等待约 {s} 秒后重试"),
            None => "，请稍后重试".to_string(),
        };
        return format!("HTTP 429 Too Many Requests：{detail}{hint}");
    }
    format!("HTTP {status}: {detail}")
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

    let url = chat_url(&config.base_url);

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
        // 先取响应头再读 body（resp.text() 会消费 resp）
        let retry_after = resp
            .headers()
            .get(reqwest::header::RETRY_AFTER)
            .and_then(|v| v.to_str().ok())
            .map(str::to_string);
        let text = resp.text().await.unwrap_or_default();
        return Err(http_error_message(status, &text, retry_after.as_deref()));
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
                    match classify_sse_data(data) {
                        // [DONE] 必须立刻终止：否则会一直读到服务端关连接为止，
                        // 对保持 keep-alive 的实现而言就是无限期挂起。
                        Some(SseDataAction::Done) => return Ok(()),
                        Some(SseDataAction::Error(msg)) => return Err(msg),
                        Some(SseDataAction::Delta(delta)) => {
                            let _ = app.emit(&format!("ai-chunk-{request_id}"), delta);
                        }
                        None => {}
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

/// 从 OpenAI 的 `message.content` 取值。
/// 多数服务返回字符串，但部分实现（及多模态端点）返回
/// `[{"type":"text","text":"..."}]` 数组：原样 `as_str()` 会得到空字符串，
/// 用户看到的就是一个空白回答。
fn extract_content(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Array(parts) => parts
            .iter()
            .filter_map(|p| p.get("text").and_then(|t| t.as_str()))
            .collect::<Vec<_>>()
            .join(""),
        _ => String::new(),
    }
}

/// 解析一次非流式 chat/completions 响应。
///
/// 抽成纯函数的原因和 `classify_sse_data` 一样：错误形态五花八门
/// （网关 200 + error、choices 为空、content 为 null、tool_calls 缺 type），
/// 内联在网络代码里无法单测，回归时会静默吞错。
fn parse_completion(body: &str) -> Result<AgentCompletion, String> {
    let v: serde_json::Value = serde_json::from_str(body)
        .map_err(|e| format!("解析接口响应失败：{e}；原始响应：{}", truncate(body, 400)))?;

    if let Some(e) = v.get("error") {
        let msg = e
            .get("message")
            .and_then(|m| m.as_str())
            .or_else(|| e.as_str())
            .unwrap_or("未知错误");
        return Err(format!("接口返回错误：{msg}"));
    }

    let choice = v
        .get("choices")
        .and_then(|c| c.get(0))
        .ok_or_else(|| format!("接口响应缺少 choices：{}", truncate(body, 400)))?;
    let message = choice.get("message").cloned().unwrap_or(serde_json::Value::Null);

    let tool_calls = match message.get("tool_calls") {
        Some(serde_json::Value::Array(_)) => {
            serde_json::from_value(message["tool_calls"].clone())
                .map_err(|e| format!("解析 tool_calls 失败：{e}"))?
        }
        _ => Vec::new(),
    };

    Ok(AgentCompletion {
        content: extract_content(&message["content"]),
        tool_calls,
        finish_reason: choice
            .get("finish_reason")
            .and_then(|x| x.as_str())
            .map(str::to_string),
    })
}

/// Agent 的一轮非流式调用：把对话（含工具结果）发给模型，返回文本 + 工具调用请求。
///
/// 非流式是刻意选择：Agent 一轮里要「拿工具结果 → 再问模型」，流式增量对该
/// 循环没有价值，反而要维护一套 tool_calls 增量拼接状态。普通对话仍走
/// `ai_chat_stream`，体验不受影响。
#[tauri::command]
pub async fn ai_chat_complete(
    config: AiConfig,
    messages: Vec<AgentMessage>,
) -> Result<AgentCompletion, String> {
    let client = Client::builder()
        .connect_timeout(Duration::from_secs(30))
        // 非流式请求必须有限总时长：上游挂住时前端 Agent 循环会永远停在「思考中」
        .timeout(Duration::from_secs(300))
        .build()
        .map_err(|e| format!("初始化请求客户端失败：{e}"))?;

    let mut body = serde_json::json!({
        "model": config.model,
        "messages": messages,
        "tools": crate::agent::tool_definitions(),
        "tool_choice": "auto",
        "stream": false,
    });
    if let Some(t) = config.temperature {
        body["temperature"] = serde_json::json!(t);
    }
    if let Some(m) = config.max_tokens {
        body["max_tokens"] = serde_json::json!(m);
    }

    let resp = client
        .post(chat_url(&config.base_url))
        .bearer_auth(config.api_key)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("请求失败：{e}"))?;

    let status = resp.status();
    let retry_after = resp
        .headers()
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let text = resp
        .text()
        .await
        .map_err(|e| format!("读取响应失败：{e}"))?;
    if !status.is_success() {
        return Err(http_error_message(status, &text, retry_after.as_deref()));
    }
    parse_completion(&text)
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---------- truncate：错误信息长度闸门 ----------

    #[test]
    fn truncate_keeps_short_strings_intact() {
        assert_eq!(truncate("abc", 3), "abc");
        assert_eq!(truncate("", 10), "");
        assert_eq!(truncate("x", 0), "");
    }

    #[test]
    fn truncate_counts_characters_not_bytes() {
        // 中文按字符计，不按字节计：截到 3 个字符，而不是 3 个字节
        // （3 字节会落在字符中间 → 产生 U+FFFD 乱码，直接显示给用户）
        let out = truncate("中文错误信息", 3);
        assert_eq!(out, "中文错");
        assert!(out.chars().count() == 3);
    }

    #[test]
    fn truncate_handles_mixed_script_and_mixed_width() {
        assert_eq!(truncate("a中b", 2), "a中");
        assert_eq!(truncate("ééé", 2), "éé");
        // emoji 是多字节字符，截断不能把它劈成半个
        let out = truncate("好🎉好", 2);
        assert_eq!(out.chars().count(), 2);
    }

    // ---------- 取消标志注册表：请求级守卫 ----------

    #[test]
    fn cancel_guard_removes_entry_on_drop() {
        // 关键健壮性：无论 ai_chat_stream 正常返回、返回错误，
        // 还是 future 被 drop（关窗 / 页面重载），CancelGuard 都必须把
        // request_id 从全局表里摘掉。否则反复开关 AI 面板会持续泄漏。
        let flag = Arc::new(AtomicBool::new(false));
        cancel_flags().lock().unwrap().insert("guard-req-1".into(), flag);
        assert!(
            cancel_flags().lock().unwrap().contains_key("guard-req-1"),
            "前置：条目应当已注册"
        );

        let _guard = CancelGuard("guard-req-1".to_string());
        drop(_guard);

        assert!(
            !cancel_flags().lock().unwrap().contains_key("guard-req-1"),
            "Drop 之后条目必须被摘除"
        );
    }

    #[test]
    fn cancel_guard_drop_is_idempotent_after_already_removed() {
        // 手动清掉之后守卫再 Drop 也不应 panic
        cancel_flags().lock().unwrap().insert("guard-req-2".into(), Arc::new(AtomicBool::new(false)));
        let g = CancelGuard("guard-req-2".to_string());
        drop(g);
        // 重复 drop 不可能发生（Rust 不允许 move 后复用），这里只验证空表状态下再查
        assert!(!cancel_flags().lock().unwrap().contains_key("guard-req-2"));
    }

    #[tokio::test]
    async fn ai_chat_cancel_sets_the_registered_flag() {
        let flag = Arc::new(AtomicBool::new(false));
        cancel_flags().lock().unwrap().insert("cancel-req-live".into(), flag.clone());

        assert!(!flag.load(Ordering::Relaxed));
        ai_chat_cancel("cancel-req-live".to_string()).await.unwrap();
        assert!(flag.load(Ordering::Relaxed), "取消标志应当被置位");
    }

    #[tokio::test]
    async fn ai_chat_cancel_is_idempotent_for_unknown_request() {
        // 请求已完成 / 从未发起时静默成功，不能报错
        ai_chat_cancel("never-existed-request".to_string())
            .await
            .unwrap();
        ai_chat_cancel("never-existed-request".to_string())
            .await
            .unwrap();
    }

    // ---------- 配置序列化：前后端字段名契约 ----------

    #[test]
    fn ai_config_uses_camel_case_wire_names() {
        // 前端按 camelCase 传参；serde 重命名错一处就是整块配置静默丢失
        let c: AiConfig = serde_json::from_value(serde_json::json!({
            "baseUrl": "http://127.0.0.1:1/v1",
            "apiKey": "sk-test",
            "model": "gpt-4",
            "temperature": 0.7,
            "maxTokens": 512
        }))
        .unwrap();
        assert_eq!(c.base_url, "http://127.0.0.1:1/v1");
        assert_eq!(c.api_key, "sk-test");
        assert_eq!(c.model, "gpt-4");
        assert_eq!(c.temperature, Some(0.7));
        assert_eq!(c.max_tokens, Some(512));

        // temperature / max_tokens 可选，缺省为 None（不会覆盖服务端默认值）
        let c2: AiConfig = serde_json::from_value(serde_json::json!({
            "baseUrl": "http://x", "apiKey": "k", "model": "m"
        }))
        .unwrap();
        assert_eq!(c2.temperature, None);
        assert_eq!(c2.max_tokens, None);
    }

    #[test]
    fn ai_message_serializes_with_camel_case() {
        let m = AiMessage {
            role: "user".into(),
            content: "你好".into(),
        };
        let v = serde_json::to_value(&m).unwrap();
        assert_eq!(v["role"], "user");
        assert_eq!(v["content"], "你好");
    }

    // ---------- SSE 数据帧分类 ----------

    #[test]
    fn classify_sse_data_returns_delta_for_normal_frame() {
        // 真实增量帧：delta.content 是一段中文
        assert_eq!(
            classify_sse_data(r#"{"choices":[{"delta":{"content":"你好"}}]}"#),
            Some(SseDataAction::Delta("你好".into()))
        );
        // 带 role / index / finish_reason 的完整帧同样只取 content
        assert_eq!(
            classify_sse_data(
                r#"{"id":"chatcmpl-1","choices":[{"index":0,"delta":{"role":"assistant","content":" world"},"finish_reason":null}]}"#
            ),
            Some(SseDataAction::Delta(" world".into()))
        );
    }

    #[test]
    fn classify_sse_data_returns_done_for_done_marker() {
        assert_eq!(classify_sse_data("[DONE]"), Some(SseDataAction::Done));
        // 前后空白不应影响判定
        assert_eq!(classify_sse_data("  [DONE]  "), Some(SseDataAction::Done));
    }

    #[test]
    fn classify_sse_data_surfaces_object_form_errors() {
        // 回归：OpenAI / DeepSeek 的错误形态是 `{"error": {"message": ...}}`
        // —— error 是**对象**而不是字符串。原先只取 as_str() 会落空，
        // 于是错误被静默吞掉，用户只得到一个空白回复。
        let got = classify_sse_data(
            r#"{"error":{"message":"Invalid API key","type":"invalid_request_error","code":"invalid_api_key"}}"#,
        );
        match got {
            Some(SseDataAction::Error(msg)) => {
                assert!(msg.contains("Invalid API key"), "msg={msg}")
            }
            other => panic!("对象形态的错误应当被识别，实际得到 {other:?}"),
        }
    }

    #[test]
    fn classify_sse_data_surfaces_string_form_errors() {
        // 部分服务（含 Ollama 兼容端点）用字符串形态
        let got = classify_sse_data(r#"{"error":"model not found"}"#);
        match got {
            Some(SseDataAction::Error(msg)) => assert!(msg.contains("model not found"), "msg={msg}"),
            other => panic!("字符串形态的错误应当被识别，实际得到 {other:?}"),
        }
        // 字符串形态不应误判为增量内容
        assert!(classify_sse_data(r#"{"error":"boom"}"#) != Some(SseDataAction::Delta("boom".into())));
    }

    #[test]
    fn classify_sse_data_ignores_frames_without_delta() {
        // 空壳帧（finish_reason 帧、空 delta 帧）不应产生增量，
        // 否则会往回复里插入多余字符。
        assert_eq!(classify_sse_data(r#"{"choices":[{"delta":{},"finish_reason":"stop"}]}"#), None);
        assert_eq!(classify_sse_data(r#"{"choices":[{"delta":{"content":""}}]}"#), None);
        assert_eq!(classify_sse_data(r#"{"choices":[]}"#), None);
        assert_eq!(classify_sse_data(r#"{"choices":[{"delta":{"role":"assistant"}}]}"#), None);
    }

    #[test]
    fn classify_sse_data_ignores_non_json_and_garbage() {
        // 注释行、心跳、截断的 JSON、纯文本都应当被忽略而不是报错
        assert_eq!(classify_sse_data(""), None);
        assert_eq!(classify_sse_data("   "), None);
        assert_eq!(classify_sse_data("not json"), None);
        assert_eq!(classify_sse_data(r#"{"choices":[{"delta":{"content":"truncated""#), None);
        assert_eq!(classify_sse_data(r#"{"choices":[{delta:1}]"#), None);
    }

    #[test]
    fn classify_sse_data_error_wins_over_choices() {
        // 异常帧里同时带 error 和 choices 时，错误优先
        let got = classify_sse_data(
            r#"{"error":{"message":"rate limited"},"choices":[{"delta":{"content":"x"}}]}"#,
        );
        assert!(matches!(got, Some(SseDataAction::Error(_))));
    }

    // ---------- 端点拼接 ----------

    #[test]
    fn chat_url_does_not_double_append_path() {
        assert_eq!(chat_url("https://api.x.com/v1"), "https://api.x.com/v1/chat/completions");
        assert_eq!(chat_url("https://api.x.com/v1/"), "https://api.x.com/v1/chat/completions");
        assert_eq!(
            chat_url("https://api.x.com/v1/chat/completions"),
            "https://api.x.com/v1/chat/completions"
        );
        assert_eq!(
            chat_url("  https://api.x.com/v1/chat/completions/  "),
            "https://api.x.com/v1/chat/completions"
        );
    }

    // ---------- 非流式响应解析（Agent）----------

    #[test]
    fn parse_completion_reads_plain_text() {
        let c = parse_completion(
            r#"{"choices":[{"message":{"role":"assistant","content":"磁盘已清理"},"finish_reason":"stop"}]}"#,
        )
        .unwrap();
        assert_eq!(c.content, "磁盘已清理");
        assert!(c.tool_calls.is_empty());
        assert_eq!(c.finish_reason.as_deref(), Some("stop"));
    }

    #[test]
    fn parse_completion_reads_tool_calls() {
        let c = parse_completion(
            r#"{"choices":[{"message":{"role":"assistant","content":null,"tool_calls":[
                {"id":"call_1","type":"function","function":{"name":"run_command","arguments":"{\"command\":\"df -h\"}"}}
            ]},"finish_reason":"tool_calls"}]}"#,
        )
        .unwrap();
        assert_eq!(c.content, "");
        assert_eq!(c.tool_calls.len(), 1);
        assert_eq!(c.tool_calls[0].id, "call_1");
        assert_eq!(c.tool_calls[0].kind, "function");
        assert_eq!(c.tool_calls[0].function.name, "run_command");
        assert!(c.tool_calls[0].function.arguments.contains("df -h"));
        assert_eq!(c.finish_reason.as_deref(), Some("tool_calls"));
    }

    #[test]
    fn parse_completion_defaults_missing_tool_type() {
        // 少数兼容实现省略 "type"，不能让整个解析失败
        let c = parse_completion(
            r#"{"choices":[{"message":{"role":"assistant","content":"","tool_calls":[
                {"id":"call_2","function":{"name":"write_script","arguments":"{}"}}
            ]}}]}"#,
        )
        .unwrap();
        assert_eq!(c.tool_calls[0].kind, "function");
    }

    #[test]
    fn parse_completion_reads_array_content() {
        let c = parse_completion(
            r#"{"choices":[{"message":{"content":[{"type":"text","text":"第一段"},{"type":"text","text":"第二段"}]}}]}"#,
        )
        .unwrap();
        assert_eq!(c.content, "第一段第二段");
    }

    #[test]
    fn parse_completion_surfaces_errors() {
        let e = parse_completion(r#"{"error":{"message":"model not found"}}"#).unwrap_err();
        assert!(e.contains("model not found"), "e={e}");
        let e = parse_completion(r#"{"error":"rate limited"}"#).unwrap_err();
        assert!(e.contains("rate limited"), "e={e}");
    }

    #[test]
    fn parse_completion_rejects_garbage() {
        assert!(parse_completion("not json").is_err());
        let e = parse_completion(r#"{"choices":[]}"#).unwrap_err();
        assert!(e.contains("choices"), "e={e}");
    }

    #[test]
    fn agent_message_wire_format_matches_openai() {
        // 回传给模型的工具调用必须是 snake_case（tool_calls / tool_call_id），
        // 与 OpenAI 协议一致；改成 camelCase 会让严格的服务端直接 400。
        let m = AgentMessage {
            role: "assistant".into(),
            content: "".into(),
            tool_calls: Some(vec![AgentToolCall {
                id: "call_1".into(),
                kind: "function".into(),
                function: AgentFunctionCall {
                    name: "run_command".into(),
                    arguments: "{}".into(),
                },
            }]),
            tool_call_id: None,
        };
        let v = serde_json::to_value(&m).unwrap();
        assert_eq!(v["role"], "assistant");
        assert!(v.get("tool_calls").is_some(), "v={v}");
        assert!(v.get("tool_call_id").is_none(), "None 字段不应被序列化");
        assert_eq!(v["tool_calls"][0]["type"], "function");

        let t = AgentMessage {
            role: "tool".into(),
            content: "ok".into(),
            tool_calls: None,
            tool_call_id: Some("call_1".into()),
        };
        let v = serde_json::to_value(&t).unwrap();
        assert_eq!(v["tool_call_id"], "call_1");
        assert!(v.get("tool_calls").is_none());
    }

    #[test]
    fn agent_completion_serializes_camel_case_for_frontend() {
        let c = AgentCompletion {
            content: "hi".into(),
            tool_calls: vec![],
            finish_reason: Some("stop".into()),
        };
        let v = serde_json::to_value(&c).unwrap();
        assert_eq!(v["content"], "hi");
        assert!(v["toolCalls"].is_array());
        assert_eq!(v["finishReason"], "stop");
    }

    // ---------- 非 2xx 错误信息 ----------

    #[test]
    fn api_error_detail_prefers_provider_message() {
        let body = r#"{"error":{"code":"","message":"请登录platform进行实名认证以获取更高rpm","type":"AgnesAI_error"}}"#;
        assert_eq!(
            api_error_detail(body),
            "请登录platform进行实名认证以获取更高rpm"
        );
        assert_eq!(api_error_detail(r#"{"error":"plain"}"#), "plain");
        // 非 JSON 时退回原文
        assert_eq!(api_error_detail("gateway timeout"), "gateway timeout");
    }

    #[test]
    fn http_error_message_handles_429_with_retry_after() {
        let body = r#"{"error":{"message":"请登录platform进行实名认证以获取更高rpm"}}"#;
        let msg = http_error_message(
            reqwest::StatusCode::TOO_MANY_REQUESTS,
            body,
            Some("12"),
        );
        assert!(msg.starts_with("HTTP 429"), "msg={msg}");
        assert!(msg.contains("实名认证"), "msg={msg}");
        assert!(msg.contains("12 秒"), "msg={msg}");
        // 没有 Retry-After 时也要给出可操作的提示
        let msg = http_error_message(reqwest::StatusCode::TOO_MANY_REQUESTS, body, None);
        assert!(msg.contains("稍后重试"), "msg={msg}");
    }

    #[test]
    fn http_error_message_keeps_other_statuses_plain() {
        let msg = http_error_message(
            reqwest::StatusCode::UNAUTHORIZED,
            r#"{"error":{"message":"invalid api key"}}"#,
            None,
        );
        assert_eq!(msg, "HTTP 401 Unauthorized: invalid api key");
    }
}
