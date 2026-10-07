import { useCallback, useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import type { AiConfig, AiMessage, AiProfile } from '../types';
import { aiChatCancel, aiChatStream, sessionRecentOutput } from '../api';

const PROFILES_KEY = 'myterm.aiProfiles';
const ACTIVE_KEY = 'myterm.aiActiveProfile';
/** 对话历史上限：超出后裁剪最旧消息，防止长会话内存与 token 无限膨胀 */
const MAX_MESSAGES = 100;

function makeId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function loadProfiles(): AiProfile[] {
  try {
    const raw = localStorage.getItem(PROFILES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (p: unknown): p is AiProfile =>
        typeof p === 'object' &&
        p !== null &&
        typeof (p as AiProfile).id === 'string' &&
        typeof (p as AiProfile).name === 'string' &&
        typeof (p as AiProfile).config?.baseUrl === 'string' &&
        typeof (p as AiProfile).config?.model === 'string',
    );
  } catch {
    return [];
  }
}

function loadActive(profiles: AiProfile[]): string {
  try {
    const id = localStorage.getItem(ACTIVE_KEY);
    if (id && profiles.some((p) => p.id === id)) return id;
  } catch {
    /* 忽略 */
  }
  return profiles[0]?.id ?? '';
}

const CHAT_KEY = 'myterm.aiChat';

/** 读取持久化的对话记录（逐条校验结构，异常时返回空，面板关闭重开不丢对话） */
function loadChat(): AiMessage[] {
  try {
    const raw = localStorage.getItem(CHAT_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (m): m is AiMessage =>
        typeof m === 'object' &&
        m !== null &&
        ((m as AiMessage).role === 'user' || (m as AiMessage).role === 'assistant') &&
        typeof (m as AiMessage).content === 'string',
    );
  } catch {
    return [];
  }
}

interface Props {
  /** 当前活跃 SSH 会话 id（用于「引用终端输出」），无则传 null */
  sessionId: string | null;
  onClose: () => void;
}

interface Editable {
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: string;
  maxTokens: string;
}

const emptyEditable: Editable = {
  name: '',
  baseUrl: '',
  apiKey: '',
  model: '',
  temperature: '',
  maxTokens: '',
};

export default function AIPanel({ sessionId, onClose }: Props) {
  const [profiles, setProfiles] = useState<AiProfile[]>(loadProfiles);
  const [activeId, setActiveId] = useState<string>('');
  const [messages, setMessages] = useState<AiMessage[]>(loadChat);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState('');
  // 配置编辑弹窗
  const [configOpen, setConfigOpen] = useState(false);
  const [editing, setEditing] = useState<Editable>(emptyEditable);
  const [saving, setSaving] = useState(false);
  // 用于「引用终端输出」
  const [attachText, setAttachText] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const chatRef = useRef<HTMLDivElement>(null);
  // 未卸载的流式监听器（卸载时清理）
  const unlistenRef = useRef<(() => void)[]>([]);
  // 当前进行中的流式请求 id（「停止生成」按钮使用）
  const reqIdRef = useRef<string | null>(null);

  // 初始化时恢复 profiles 与选中项
  useEffect(() => {
    const list = loadProfiles();
    setProfiles(list);
    setActiveId(loadActive(list));
  }, []);

  // 持久化 profiles 与选中项
  useEffect(() => {
    try {
      localStorage.setItem(PROFILES_KEY, JSON.stringify(profiles));
    } catch {
      /* 忽略 */
    }
  }, [profiles]);
  useEffect(() => {
    try {
      localStorage.setItem(ACTIVE_KEY, activeId);
    } catch {
      /* 忽略 */
    }
  }, [activeId]);

  // 对话记录持久化（带上限裁剪；「清空对话」后存入空数组即视为重置）
  useEffect(() => {
    try {
      localStorage.setItem(CHAT_KEY, JSON.stringify(messages.slice(-MAX_MESSAGES)));
    } catch {
      /* 存储失败时忽略 */
    }
  }, [messages]);

  // Esc 关闭 + 卸载时清理监听。
  // 注意：焦点在终端或输入框内时按 Esc 是正常操作（vim 退出插入模式、
  // 取消命令、关闭输入法候选等），不能误关面板——仅当焦点在页面空白处才关闭。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === 'INPUT' ||
          t.tagName === 'TEXTAREA' ||
          t.isContentEditable ||
          t.closest('.xterm') !== null)
      ) {
        return;
      }
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      unlistenRef.current.forEach((fn) => {
        try {
          fn();
        } catch {
          /* 忽略 */
        }
      });
      unlistenRef.current = [];
    };
  }, [onClose]);

  const activeProfile = profiles.find((p) => p.id === activeId) ?? null;

  const scrollToBottom = useCallback(() => {
    const el = chatRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  // 更新流式回答（最后一条 assistant 消息）
  const updateLastAssistant = useCallback((content: string) => {
    setMessages((ms) => {
      const idx = ms.length - 1;
      if (idx < 0 || ms[idx].role !== 'assistant') return ms;
      const next = [...ms];
      next[idx] = { ...next[idx], content };
      return next;
    });
  }, []);

  const send = async (override?: string) => {
    const text = (override ?? input).trim();
    if (!text || streaming) return;
    if (!activeProfile) {
      setError('请先在顶部配置并选择一个 AI 模型');
      setConfigOpen(true);
      return;
    }
    const userMsg: AiMessage = { role: 'user', content: text };
    let next = [...messages, userMsg];
    // 超出上限时裁剪最旧消息，并确保裁剪后仍以用户消息开头（符合对话 API 习惯）
    if (next.length > MAX_MESSAGES) {
      next = next.slice(-MAX_MESSAGES);
      while (next.length > 0 && next[0].role !== 'user') next.shift();
    }
    setMessages([...next, { role: 'assistant', content: '' }]);
    setInput('');
    setError('');
    setStreaming(true);

    const reqId = makeId();
    reqIdRef.current = reqId;
    let acc = '';
    let unChunk: (() => void) | null = null;
    let unDone: (() => void) | null = null;
    const cleanupListeners = () => {
      if (unChunk) {
        unChunk();
        unlistenRef.current = unlistenRef.current.filter((f) => f !== unChunk);
        unChunk = null;
      }
      if (unDone) {
        unDone();
        unlistenRef.current = unlistenRef.current.filter((f) => f !== unDone);
        unDone = null;
      }
      reqIdRef.current = null;
    };
    try {
      unChunk = await listen<string>(`ai-chunk-${reqId}`, (e) => {
        acc += e.payload;
        updateLastAssistant(acc);
      });
      unDone = await listen(`ai-done-${reqId}`, () => {
        cleanupListeners();
        setStreaming(false);
      });
      unlistenRef.current.push(unChunk, unDone);
    } catch (e) {
      cleanupListeners();
      setStreaming(false);
      updateLastAssistant(acc ? `${acc}\n\n（请求中断：${e}）` : `（请求失败：${e}）`);
      setError(String(e));
      return;
    }

    try {
      await aiChatStream(reqId, activeProfile.config, next);
    } catch (e) {
      cleanupListeners();
      setStreaming(false);
      updateLastAssistant(acc ? `${acc}\n\n（请求中断：${e}）` : `（请求失败：${e}）`);
      setError(String(e));
    }
  };

  // 停止生成：通知后端置位取消标志（断开上游连接），并立即结束本地流式状态。
  // 同一时刻只有一个请求在流式（send 有 streaming 守卫），清空全部监听器是安全的。
  const stopStreaming = () => {
    if (!streaming) return;
    const id = reqIdRef.current;
    if (id) void aiChatCancel(id).catch(() => {});
    unlistenRef.current.forEach((fn) => {
      try {
        fn();
      } catch {
        /* 忽略 */
      }
    });
    unlistenRef.current = [];
    reqIdRef.current = null;
    setStreaming(false);
    setMessages((ms) => {
      const idx = ms.length - 1;
      if (idx < 0 || ms[idx].role !== 'assistant') return ms;
      const next = [...ms];
      next[idx] = {
        ...next[idx],
        content: next[idx].content ? `${next[idx].content}\n\n（已手动停止）` : '（已手动停止）',
      };
      return next;
    });
  };

  // 引用当前终端最近输出到对话
  const attachTerminalOutput = async () => {
    if (!sessionId) {
      setError('当前没有可引用的 SSH 会话');
      return;
    }
    setError('');
    try {
      const out = await sessionRecentOutput(sessionId, 8000);
      const snippet = out.trim().slice(-6000);
      setAttachText(snippet);
    } catch (e) {
      setError(String(e));
    }
  };

  const sendWithAttach = () => {
    const userText = attachText
      ? `以下是服务器终端最近的一段输出，请据此分析/回答：\n\n\`\`\`\n${attachText}\n\`\`\`\n\n${input}`
      : input;
    setAttachText('');
    void send(userText);
  };

  const openConfig = () => {
    setEditing(
      activeProfile
        ? {
            name: activeProfile.name,
            baseUrl: activeProfile.config.baseUrl,
            apiKey: activeProfile.config.apiKey,
            model: activeProfile.config.model,
            temperature:
              activeProfile.config.temperature !== undefined
                ? String(activeProfile.config.temperature)
                : '',
            maxTokens:
              activeProfile.config.maxTokens !== undefined
                ? String(activeProfile.config.maxTokens)
                : '',
          }
        : emptyEditable,
    );
    setConfigOpen(true);
    // 弹窗打开后延迟聚焦第一个输入域，确保输入框可见
    setTimeout(() => {
      const firstInput = document.querySelector('.modal-backdrop .field:first-child input') as HTMLInputElement;
      if (firstInput) firstInput.focus();
    }, 100);
  };

  const saveConfig = () => {
    const name = editing.name.trim();
    const baseUrl = editing.baseUrl.trim();
    const model = editing.model.trim();
    if (!name || !baseUrl || !model) {
      setError('名称、BaseURL、模型名不能为空');
      return;
    }
    setSaving(true);
    const config: AiConfig = {
      baseUrl,
      apiKey: editing.apiKey.trim(),
      model,
      temperature: editing.temperature.trim() ? Number(editing.temperature) : undefined,
      maxTokens: editing.maxTokens.trim() ? Number(editing.maxTokens) : undefined,
    };
    if (activeProfile) {
      setProfiles((ps) =>
        ps.map((p) => (p.id === activeProfile.id ? { ...p, name, config } : p)),
      );
    } else {
      const np: AiProfile = { id: makeId(), name, config };
      setProfiles((ps) => [...ps, np]);
      setActiveId(np.id);
    }
    setConfigOpen(false);
    setSaving(false);
  };

  const removeProfile = () => {
    if (!activeProfile) return;
    const next = profiles.filter((p) => p.id !== activeProfile.id);
    setProfiles(next);
    setActiveId(loadActive(next));
    setConfigOpen(false);
  };

  return (
    <div className="sftp-panel snippet-panel ai-panel">
      <div className="sftp-header">
        <span className="sftp-title">AI 助手</span>
        <div className="sftp-header-actions">
          <button className="icon-btn" title="配置模型" onClick={openConfig}>
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
            </svg>
          </button>
          <button className="icon-btn" title="清空对话" onClick={() => setMessages([])}>
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" />
            </svg>
          </button>
          <button className="icon-btn" title="关闭" onClick={onClose}>
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>
      </div>

      <div className="ai-config">
        <select
          className="snippet-input"
          value={activeId}
          onChange={(e) => setActiveId(e.target.value)}
          title="选择 AI 模型"
        >
          {profiles.length === 0 && <option value="">未配置模型</option>}
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} · {p.config.model}
            </option>
          ))}
        </select>
        <button className="mini-btn" onClick={openConfig} title="新建/编辑模型配置">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round">
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>
      </div>

      <div className="ai-chat" ref={chatRef}>
        {messages.length === 0 && (
          <div className="host-empty">
            <p>与 AI 模型对话</p>
            <p className="host-empty-sub">
              可提问、让 AI 生成命令、或点「引用输出」把终端最近输出交给它分析
            </p>
          </div>
        )}
        {messages.map((m, i) =>
          m.role === 'user' ? (
            <div className="ai-msg ai-msg-user" key={i}>
              <div className="ai-bubble">{m.content}</div>
            </div>
          ) : (
            <div className="ai-msg ai-msg-ai" key={i}>
              <div className={`ai-bubble${m.content === '' ? ' ai-typing' : ''}`}>
                {m.content === '' ? '思考中…' : m.content}
              </div>
            </div>
          ),
        )}
      </div>

      <div className="ai-input-row">
        {attachText && (
          <div className="ai-attach">
            <span>已引用终端输出（{attachText.length} 字符）</span>
            <button className="mini-btn" onClick={() => setAttachText('')}>
              取消
            </button>
          </div>
        )}
        <textarea
          ref={inputRef}
          className="ai-textarea"
          rows={3}
          value={input}
          placeholder={activeProfile ? '输入你的问题，Enter 发送，Shift+Enter 换行' : '请先配置模型'}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <div className="ai-input-actions">
          <button
            className="mini-btn"
            title="把当前终端最近输出交给 AI 分析"
            onClick={() => void attachTerminalOutput()}
          >
            引用输出
          </button>
          <span className="ai-spacer" />
          {streaming && (
            <button className="btn ghost" onClick={stopStreaming} title="中断本次生成">
              停止
            </button>
          )}
          <button className="btn primary" onClick={() => void sendWithAttach()} disabled={streaming}>
            {streaming ? '生成中…' : '发送'}
          </button>
        </div>
        {error && <div className="form-error">{error}</div>}
      </div>

      {configOpen && (
        <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !saving && setConfigOpen(false)}>
          <div className="modal">
            <div className="modal-header">
              <h2>{activeProfile ? '编辑模型配置' : '新增模型配置'}</h2>
              <button className="icon-btn" onClick={() => !saving && setConfigOpen(false)} title="关闭">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            </div>
            <div className="modal-body">
              <div className="field">
                <span>配置名称</span>
                <input value={editing.name} placeholder="如：DeepSeek / Qwen / GLM" spellCheck={false} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
              </div>
              <div className="field">
                <span>BaseURL（OpenAI 兼容）</span>
                <input value={editing.baseUrl} placeholder="https://api.deepseek.com/v1" spellCheck={false} onChange={(e) => setEditing({ ...editing, baseUrl: e.target.value })} />
              </div>
              <div className="field">
                <span>API Key</span>
                <input value={editing.apiKey} type="password" placeholder="sk-…" spellCheck={false} onChange={(e) => setEditing({ ...editing, apiKey: e.target.value })} />
              </div>
              <div className="field">
                <span>模型名</span>
                <input value={editing.model} placeholder="deepseek-chat" spellCheck={false} onChange={(e) => setEditing({ ...editing, model: e.target.value })} />
              </div>
              <div className="ai-cfg-grid">
                <div className="field">
                  <span>温度（可选）</span>
                  <input value={editing.temperature} placeholder="0.7" spellCheck={false} onChange={(e) => setEditing({ ...editing, temperature: e.target.value })} />
                </div>
                <div className="field">
                  <span>最大 tokens（可选）</span>
                  <input value={editing.maxTokens} placeholder="如 4096" spellCheck={false} onChange={(e) => setEditing({ ...editing, maxTokens: e.target.value })} />
                </div>
              </div>
            </div>
            <div className="modal-footer">
              {activeProfile && (
                <button className="btn danger-btn" disabled={saving} onClick={removeProfile}>
                  删除
                </button>
              )}
              <span className="ai-spacer" />
              <button className="btn ghost" disabled={saving} onClick={() => setConfigOpen(false)}>
                取消
              </button>
              <button className="btn primary" disabled={saving} onClick={saveConfig}>
                {saving ? '保存中…' : '保存'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
