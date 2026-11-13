import { useCallback, useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import type {
  AiAgentRound,
  AiConfig,
  AiMessage,
  AiProfile,
  AiToolCall,
  AiToolResult,
  AgentCompletion,
  AgentMessage,
} from '../types';
import {
  agentCancel,
  agentRunCommand,
  agentWriteScript,
  aiChatCancel,
  aiChatComplete,
  aiChatStream,
  sessionRecentOutput,
} from '../api';

const PROFILES_KEY = 'myterm.aiProfiles';
const ACTIVE_KEY = 'myterm.aiActiveProfile';
const MODE_KEY = 'myterm.aiMode';
const AUTO_RUN_KEY = 'myterm.aiAutoRun';
/** 对话历史上限：超出后裁剪最旧消息，防止长会话内存与 token 无限膨胀 */
const MAX_MESSAGES = 100;
/** Agent 单轮请求最多执行几轮工具（防止模型陷入死循环烧 token） */
const MAX_AGENT_STEPS = 8;
/** 单个工具输出回传给模型的字符上限（头 + 尾保留，中间截断） */
const MAX_TOOL_OUTPUT_FOR_MODEL = 8000;
/** 展示 / 持久化的输出上限（localStorage 只有几 MB） */
const MAX_TOOL_OUTPUT_FOR_UI = 20_000;
/** 回放给模型的对话上下文总字符预算 */
const MAX_CONTEXT_CHARS = 60_000;


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

/** 为消息生成稳定 id（持久化记录里没有 id 的旧数据也在这里补上） */
let msgSeq = 0;
function nextMsgId(): string {
  msgSeq += 1;
  return `m${Date.now().toString(36)}-${msgSeq}`;
}

/** 读取持久化的对话记录（逐条校验结构，异常时返回空，面板关闭重开不丢对话） */
function loadChat(): AiMessage[] {
  try {
    const raw = localStorage.getItem(CHAT_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (m): m is AiMessage =>
          typeof m === 'object' &&
          m !== null &&
          ((m as AiMessage).role === 'user' || (m as AiMessage).role === 'assistant') &&
          typeof (m as AiMessage).content === 'string',
      )
      // 旧版本持久化的记录没有 id，这里补齐以保证 key 稳定
      .map((m) => {
        const rounds = sanitizeRounds((m as AiMessage).rounds);
        return {
          ...m,
          id: typeof m.id === 'string' ? m.id : nextMsgId(),
          // 必须显式覆盖：无效的旧 rounds 若随 ...m 保留下来，渲染时会崩
          rounds,
        };
      });
  } catch {
    return [];
  }
}

/**
 * 校验持久化的 Agent 轨迹。
 *
 * localStorage 可能来自旧版本或被手工改坏；缺少这层校验，渲染时
 * `round.toolCalls.map(...)` 会直接抛错并让整个 AI 面板白屏。
 */
function sanitizeRounds(raw: unknown): AiAgentRound[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const rounds: AiAgentRound[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Partial<AiAgentRound>;
    if (!Array.isArray(r.toolCalls)) continue;
    const toolCalls: AiToolCall[] = [];
    for (const c of r.toolCalls) {
      if (!c || typeof c !== 'object') continue;
      const call = c as Partial<AiToolCall>;
      if (typeof call.id !== 'string' || typeof call.function?.name !== 'string') continue;
      toolCalls.push({
        id: call.id,
        type: typeof call.type === 'string' ? call.type : 'function',
        function: {
          name: call.function.name,
          arguments:
            typeof call.function.arguments === 'string' ? call.function.arguments : '{}',
        },
      });
    }
    if (toolCalls.length === 0) continue;
    const results: AiToolResult[] = Array.isArray(r.results)
      ? r.results.filter(
          (x): x is AiToolResult =>
            !!x &&
            typeof x === 'object' &&
            typeof (x as AiToolResult).toolCallId === 'string' &&
            typeof (x as AiToolResult).output === 'string',
        )
      : [];
    rounds.push({
      content: typeof r.content === 'string' ? r.content : '',
      toolCalls,
      results,
    });
  }
  return rounds.length ? rounds : undefined;
}

/** 深拷贝轨迹，避免 React 看到同一个数组引用而跳过重渲染 */
function snapshotRounds(rounds: AiAgentRound[]): AiAgentRound[] {
  return rounds.map((r) => ({
    content: r.content,
    toolCalls: r.toolCalls.map((c) => ({ ...c, function: { ...c.function } })),
    results: r.results.map((x) => ({ ...x })),
  }));
}

/** 按字符截断（保留头尾），避免超长工具输出撑爆 localStorage / 上下文 */
function clipText(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.35);
  const tail = max - head;
  return `${text.slice(0, head)}\n\n…（中间省略 ${text.length - head - tail} 字符）…\n\n${text.slice(-tail)}`;
}

/** 截断工具输出：保留头部与尾部（报错往往在末尾），中间省略 */
function clipForModel(text: string): string {
  return clipText(text, MAX_TOOL_OUTPUT_FOR_MODEL);
}

/** 界面状态栏里显示的命令摘要 */
function brief(text: string, max = 70): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * 是否属于「请求太频繁」（HTTP 429）。
 *
 * 中转平台（如 AgnesAI）对未实名账号的 RPM 很低，而 Agent 一条消息可能
 * 连发多轮请求，很容易撞上。识别出来后走退避重试 + 友好提示，而不是
 * 把一整段 JSON 直接甩到界面上。
 */
function isRateLimitError(e: unknown): boolean {
  return /HTTP\s*429|too many requests|rate[\s_-]?limit/i.test(String(e));
}

/** 从后端错误里取等待秒数（后端写入「请等待约 N 秒后重试」），默认 5 秒，限制 3–60 */
function retryAfterSecs(e: unknown): number {
  const m = /等待约\s*(\d+)\s*秒/.exec(String(e));
  const n = m ? Number(m[1]) : 5;
  if (!Number.isFinite(n)) return 5;
  return Math.min(Math.max(n, 3), 60);
}

/** 429 的友好文案：告诉用户该等多久、该做什么 */
function rateLimitText(raw: string): string {
  return (
    '接口限流（HTTP 429）：当前模型账号的每分钟请求数（RPM）已达上限。\n' +
    '• 稍等 1 分钟再试；\n' +
    '• 若使用 AgnesAI 等中转平台，按提示登录平台完成实名认证可提升 RPM；\n' +
    '• Agent 模式一条消息会连发多轮请求，比普通对话更容易触发限流；\n' +
    '• 也可以换一个模型 / 账号。\n\n' +
    `原始信息：${raw}`
  );
}


/** 解析工具参数（模型可能给出非法 JSON，不能让整个 Agent 崩掉） */
function parseToolArgs(raw: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(raw || '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function toolLabel(call: AiToolCall): string {
  const args = parseToolArgs(call.function.arguments);
  if (call.function.name === 'run_command') {
    const cmd = typeof args.command === 'string' ? args.command : '';
    return cmd ? `$ ${cmd}` : '执行命令';
  }
  if (call.function.name === 'write_script') {
    const path = typeof args.path === 'string' ? args.path : '';
    return path ? `写脚本 ${path}` : '写脚本';
  }
  return call.function.name;
}

/** 把 Agent 历史还原成 OpenAI 协议消息（含 tool_calls / tool 结果） */
function buildAgentMessages(history: AiMessage[], system: string): AgentMessage[] {
  const tail: AgentMessage[] = [];
  let budget = MAX_CONTEXT_CHARS;

  for (let i = history.length - 1; i >= 0 && budget > 0; i--) {
    const m = history[i];
    const batch: AgentMessage[] = [];
    if (m.role === 'user') {
      batch.push({ role: 'user', content: m.content });
    } else if (m.role === 'assistant') {
      for (const round of m.rounds ?? []) {
        if (round.toolCalls.length === 0) continue;
        batch.push({
          role: 'assistant',
          content: round.content || '',
          tool_calls: round.toolCalls,
        });
        for (const call of round.toolCalls) {
          const r = round.results.find((x) => x.toolCallId === call.id);
          batch.push({
            role: 'tool',
            tool_call_id: call.id,
            content: clipForModel(r?.output ?? '（该工具未执行）'),
          });
        }
      }
      if (m.content) batch.push({ role: 'assistant', content: m.content });
    }
    const cost = batch.reduce((n, b) => n + b.content.length + 40, 0);
    if (cost > budget && tail.length > 0) break;
    budget -= cost;
    tail.unshift(...batch);
  }

  return [{ role: 'system', content: system }, ...tail];
}

/** Agent 系统提示词 */
function agentSystemPrompt(host: string | null): string {
  return `你是运行在 SSH 终端工具 MyTerm 中的服务器运维 Agent，当前已连接到 ${
    host || '用户的远程服务器'
  }。

你可以调用以下工具直接在该服务器上操作：
- run_command：执行非交互式 shell 命令，返回 stdout / stderr / 退出码；
- write_script：把完整 shell 脚本写到指定路径，自动创建父目录并 chmod 755，可选择立即执行。

行为准则：
1. 先用一两句话说明你的判断和计划，再调用工具。一轮可以并行调用多个互不依赖的工具。
2. 先只读收集信息（df、du、ps、systemctl status、日志等），确认后再修改。不要执行破坏性操作（rm -rf /、mkfs、dd 写盘、关机重启等）。
3. 生成脚本时使用 write_script，content 写完整脚本（含 #!/usr/bin/env bash、set -euo pipefail、必要注释）。路径用绝对路径；不确定家目录时先 run_command 执行 echo $HOME。
4. 脚本写好后用 run_command 执行 bash -n <路径> 检查语法；需要试运行时优先加 --dry-run 等安全参数，或先向用户说明。
5. 命令不支持交互式输入（vi/top/su 输密码等）。安装软件请加 -y，分页命令加 --no-pager。
6. exec 通道不会加载 ~/.bashrc；如果 hdfs / hive / java 等命令提示 command not found，请在命令前加 source /etc/profile 2>/dev/null; 或改用绝对路径。
7. 工具输出会原样返回给你。不要编造没有执行过的命令或输出。
8. 完成后用中文简短总结：做了什么、结果如何、脚本路径与用法、后续建议。`;
}


interface Props {
  /** 当前活跃 SSH 会话 id（用于「引用终端输出」与 Agent 命令执行），无则传 null */
  sessionId: string | null;
  /** 当前会话的 username@host，用于 Agent 系统提示词 */
  host?: string | null;
  onClose: () => void;
}

/** 执行前确认条目的内容 */
interface ApprovalRequest {
  title: string;
  detail: string;
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

export default function AIPanel({ sessionId, host, onClose }: Props) {
  const [profiles, setProfiles] = useState<AiProfile[]>(loadProfiles);
  const [activeId, setActiveId] = useState<string>('');
  const [messages, setMessages] = useState<AiMessage[]>(loadChat);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState('');
  // 'chat' = 纯对话（流式）；'agent' = 可在服务器执行命令 / 写脚本
  const [mode, setMode] = useState<'chat' | 'agent'>(() => {
    try {
      return localStorage.getItem(MODE_KEY) === 'agent' ? 'agent' : 'chat';
    } catch {
      return 'chat';
    }
  });
  /** 是否无需逐条确认就执行工具（默认开启，符合「自动执行」的诉求） */
  const [autoRun, setAutoRun] = useState<boolean>(() => {
    try {
      return localStorage.getItem(AUTO_RUN_KEY) !== '0';
    } catch {
      return true;
    }
  });
  /** Agent 当前阶段提示（请求模型 / 执行命令 …） */
  const [agentStatus, setAgentStatus] = useState('');
  /** 待用户确认的工具调用 */
  const [approval, setApproval] = useState<ApprovalRequest | null>(null);
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
  // 请求代次：用于丢弃上一轮（已被停止 / 已过期）请求的迟到回调
  const reqGenRef = useRef(0);
  // Agent 工具确认的 Promise 回调（停止 / 卸载时按「跳过」收尾）
  const approvalRef = useRef<((ok: boolean) => void) | null>(null);
  // 正在执行的远程命令请求 id（「停止」时用于中断后端通道）
  const activeToolRef = useRef<string | null>(null);
  // autoRun 的 ref：Agent 循环是长闭包，不能读到变更前的 state
  const autoRunRef = useRef(autoRun);
  // 对话持久化防抖定时器
  const persistTimerRef = useRef<number | null>(null);
  // 组件是否存活：在两次 await 之间防止把监听器注册到已卸载的面板上
  const aliveRef = useRef(true);
  // 弹窗自动聚焦的定时器句柄（卸载时清理）
  const focusTimerRef = useRef<number | null>(null);

  useEffect(() => {
    autoRunRef.current = autoRun;
    try {
      localStorage.setItem(AUTO_RUN_KEY, autoRun ? '1' : '0');
    } catch {
      /* 忽略 */
    }
  }, [autoRun]);

  useEffect(() => {
    try {
      localStorage.setItem(MODE_KEY, mode);
    } catch {
      /* 忽略 */
    }
  }, [mode]);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      // 卸载时作废进行中的 Agent：否则拿到模型回复后仍会 setState 已卸载组件
      reqGenRef.current += 1;
      const runningTool = activeToolRef.current;
      activeToolRef.current = null;
      if (runningTool) void agentCancel(runningTool).catch(() => {});
      const pending = approvalRef.current;
      approvalRef.current = null;
      if (pending) pending(false);
      if (focusTimerRef.current !== null) {
        window.clearTimeout(focusTimerRef.current);
        focusTimerRef.current = null;
      }
    };
  }, []);


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
  //
  // 必须防抖：流式回答期间 messages 每个分片都会变一次，原实现对每次变更都做
  // 一次 JSON.stringify(全量) + **同步阻塞**的 localStorage.setItem。
  // 一段稍长的回答就是每秒几十次全量序列化加磁盘同步写，把主线程压满。
  useEffect(() => {
    if (persistTimerRef.current !== null) window.clearTimeout(persistTimerRef.current);
    persistTimerRef.current = window.setTimeout(() => {
      persistTimerRef.current = null;
      try {
        localStorage.setItem(CHAT_KEY, JSON.stringify(messages.slice(-MAX_MESSAGES)));
      } catch {
        /* 存储失败时忽略 */
      }
    }, 800);
    return () => {
      if (persistTimerRef.current !== null) {
        window.clearTimeout(persistTimerRef.current);
        persistTimerRef.current = null;
      }
    };
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

  // ---------- Agent：工具执行 ----------

  /** 按 id 修改某条 assistant 消息（Agent 轨迹是渐进填充的） */
  const patchAssistant = (id: string, patch: (m: AiMessage) => AiMessage) => {
    setMessages((ms) => ms.map((m) => (m.id === id ? patch(m) : m)));
  };

  /** 等待用户点「允许执行 / 跳过」 */
  const askApproval = (req: ApprovalRequest): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      const previous = approvalRef.current;
      approvalRef.current = (ok) => {
        if (previous) previous(false);
        resolve(ok);
      };
      setApproval(req);
    });

  const resolveApproval = (ok: boolean) => {
    const pending = approvalRef.current;
    approvalRef.current = null;
    setApproval(null);
    if (pending) pending(ok);
  };

  /** 把后端命令结果整理成给模型看的一段文本 */
  const formatExecOutput = (r: {
    stdout: string;
    stderr: string;
    exitCode: number;
    truncated: boolean;
    durationMs: number;
  }): string => {
    const parts: string[] = [];
    if (r.stdout.trim()) parts.push(r.stdout.trimEnd());
    if (r.stderr.trim()) parts.push(`[stderr]\n${r.stderr.trimEnd()}`);
    if (parts.length === 0) parts.push('（无输出）');
    if (r.truncated) parts.push('（输出过长，已截断）');
    return `[exit ${r.exitCode} · ${r.durationMs}ms]\n${parts.join('\n')}`;
  };

  /** 执行一次工具调用；任何失败都转成工具结果回给模型，而不是中断整个 Agent */
  const runTool = async (call: AiToolCall): Promise<AiToolResult> => {
    const base = { toolCallId: call.id, name: call.function.name };
    const args = parseToolArgs(call.function.arguments);
    const rawArgs = call.function.arguments;

    if (!sessionId) {
      return { ...base, ok: false, output: '当前没有可用的 SSH 会话，无法执行工具。' };
    }

    if (call.function.name === 'run_command') {
      const command = typeof args.command === 'string' ? args.command.trim() : '';
      if (!command) {
        return { ...base, ok: false, output: 'run_command 缺少 command 参数。' };
      }
      if (!autoRunRef.current) {
        const ok = await askApproval({
          title: 'AI 请求执行命令',
          detail: command,
        });
        if (!ok) {
          return {
            ...base,
            ok: false,
            skipped: true,
            command,
            output: '用户跳过了这条命令，命令未执行。请换一种方式或询问用户。',
          };
        }
      }
      const toolRequestId = makeId();
      try {
        const timeoutRaw = Number(args.timeout_secs);
        const timeout = Number.isFinite(timeoutRaw)
          ? Math.min(300, Math.max(1, Math.round(timeoutRaw)))
          : undefined;
        activeToolRef.current = toolRequestId;
        const r = await agentRunCommand(sessionId, command, timeout, toolRequestId);
        return {
          ...base,
          ok: r.exitCode === 0,
          command,
          exitCode: r.exitCode,
          durationMs: r.durationMs,
          output: clipText(formatExecOutput(r), MAX_TOOL_OUTPUT_FOR_UI),
        };
      } catch (e) {
        return { ...base, ok: false, command, output: `执行失败：${e}` };
      } finally {
        if (activeToolRef.current === toolRequestId) activeToolRef.current = null;
      }
    }

    if (call.function.name === 'write_script') {
      const path = typeof args.path === 'string' ? args.path.trim() : '';
      const script = typeof args.content === 'string' ? args.content : '';
      const execute = args.execute === true || args.execute === 'true';
      if (!path || !script) {
        return { ...base, ok: false, path, output: 'write_script 缺少 path 或 content 参数。' };
      }
      if (!autoRunRef.current) {
        const preview =
          script.length > 1600 ? `${script.slice(0, 1600)}\n…（共 ${script.length} 字符）` : script;
        const ok = await askApproval({
          title: `AI 请求写入脚本${execute ? '并立即执行' : ''}`,
          detail: `${path}\n\n${preview}`,
        });
        if (!ok) {
          return {
            ...base,
            ok: false,
            skipped: true,
            path,
            script: script.slice(0, 20_000),
            output: `用户跳过了写入 ${path}，文件未创建。请询问用户或调整方案。`,
          };
        }
      }
      const toolRequestId = makeId();
      try {
        const timeoutRaw = Number(args.timeout_secs);
        const timeout = Number.isFinite(timeoutRaw)
          ? Math.min(300, Math.max(1, Math.round(timeoutRaw)))
          : undefined;
        activeToolRef.current = toolRequestId;
        const r = await agentWriteScript(
          sessionId,
          path,
          script,
          execute,
          timeout,
          toolRequestId,
        );
        let output = `已写入 ${r.path}（${r.bytes} 字节，chmod ${r.mode}）。`;
        if (r.exec) {
          output += `\n\n脚本已执行：\n${formatExecOutput(r.exec)}`;
        } else {
          output += `\n（未执行；如需运行请调用 run_command：bash ${r.path}）`;
        }
        return {
          ...base,
          ok: r.exec ? r.exec.exitCode === 0 : true,
          path: r.path,
          script: script.slice(0, 20_000),
          exitCode: r.exec?.exitCode,
          durationMs: r.exec?.durationMs,
          output: clipText(output, MAX_TOOL_OUTPUT_FOR_UI),
        };
      } catch (e) {
        return { ...base, ok: false, path, script: script.slice(0, 20_000), output: `写入失败：${e}` };
      } finally {
        if (activeToolRef.current === toolRequestId) activeToolRef.current = null;
      }
    }

    return {
      ...base,
      ok: false,
      output: `未知工具：${call.function.name}（参数：${rawArgs.slice(0, 200)}）`,
    };
  };

  /** Agent 主循环：模型 → 工具 → 结果 → 模型 … 直到模型给出最终答复 */
  const runAgent = async (text: string) => {
    if (!activeProfile) {
      setError('请先在顶部配置并选择一个 AI 模型');
      setConfigOpen(true);
      return;
    }
    if (!sessionId) {
      setError('Agent 模式需要当前标签是一个已连接的 SSH 终端');
      return;
    }

    const userMsg: AiMessage = { role: 'user', content: text, id: nextMsgId() };
    let next = [...messages, userMsg];
    if (next.length > MAX_MESSAGES) {
      next = next.slice(-MAX_MESSAGES);
      while (next.length > 0 && next[0].role !== 'user') next.shift();
    }
    const assistantId = nextMsgId();
    const historyForApi = [...next];
    setMessages([...next, { role: 'assistant', content: '', id: assistantId, rounds: [] }]);
    setInput('');
    setError('');
    setStreaming(true);
    setAgentStatus('正在请求模型…');

    const myGen = ++reqGenRef.current;
    const isCurrent = () => myGen === reqGenRef.current && aliveRef.current;
    const apiMessages = buildAgentMessages(historyForApi, agentSystemPrompt(host ?? null));
    const rounds: AiAgentRound[] = [];

    /**
     * 请求模型（限流时自动退避重试）。
     *
     * Agent 一条消息会连发多轮请求，中转平台的 RPM 限制很容易被撞上；
     * 直接把 429 抛给用户等于整轮工作白做。最多重试 2 次，按后端给出的
     * Retry-After（或默认 5 / 15 秒）等待，期间显示倒计时。
     */
    const completeWithRetry = async (): Promise<AgentCompletion> => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await aiChatComplete(activeProfile.config, apiMessages);
        } catch (e) {
          if (!isCurrent() || !isRateLimitError(e) || attempt >= 2) throw e;
          let wait = Math.min(retryAfterSecs(e) * (attempt + 1), 60);
          while (wait > 0) {
            if (!isCurrent()) throw e;
            setAgentStatus(`接口限流，${wait} 秒后自动重试（${attempt + 1}/2）…`);
            await sleep(1000);
            wait -= 1;
          }
          setAgentStatus('正在重试…');
        }
      }
    };

    let finalText = '';
    try {
      for (let step = 1; step <= MAX_AGENT_STEPS; step++) {
        if (!isCurrent()) return;
        setAgentStatus(step === 1 ? '正在请求模型…' : `第 ${step} 轮 · 等待模型…`);
        const res = await completeWithRetry();
        if (!isCurrent()) return;

        const calls = res.toolCalls ?? [];
        const note = (res.content ?? '').trim();
        if (calls.length === 0) {
          finalText = note;
          break;
        }

        const round: AiAgentRound = { content: note, toolCalls: calls, results: [] };
        rounds.push(round);
        patchAssistant(assistantId, (m) => ({ ...m, rounds: snapshotRounds(rounds) }));
        apiMessages.push({ role: 'assistant', content: note, tool_calls: calls });

        for (const call of calls) {
          if (!isCurrent()) return;
          setAgentStatus(`执行中：${brief(toolLabel(call))}`);
          const result = await runTool(call);
          if (!isCurrent()) return;
          round.results.push(result);
          apiMessages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: clipForModel(result.output),
          });
          patchAssistant(assistantId, (m) => ({ ...m, rounds: snapshotRounds(rounds) }));
        }

        if (step === MAX_AGENT_STEPS) {
          finalText = `（已达到单轮最多 ${MAX_AGENT_STEPS} 步工具调用，先停在这里。回复「继续」可以接着做。）`;
        }
      }

      if (!isCurrent()) return;
      patchAssistant(assistantId, (m) => ({
        ...m,
        content: finalText || '（模型没有返回文字说明，请查看上方工具执行结果）',
        rounds: snapshotRounds(rounds),
      }));
      setStreaming(false);
      setAgentStatus('');
    } catch (e) {
      if (!isCurrent()) return;
      const raw = String(e);
      const limited = isRateLimitError(e);
      const hint = limited
        ? '\n\n（接口限流：已自动重试仍失败。请稍等 1 分钟，或换 RPM 更高的模型 / 账号。）'
        : /tool|function|function_call/i.test(raw)
          ? '\n\n提示：当前模型可能不支持 function calling（工具调用），请换用 DeepSeek / Qwen / GPT 等支持该能力的模型。'
          : '';
      patchAssistant(assistantId, (m) => ({
        ...m,
        content: m.content
          ? `${m.content}\n\n（Agent 执行中断：${raw}${hint}）`
          : `（Agent 执行失败：${raw}${hint}）`,
        rounds: snapshotRounds(rounds),
      }));
      setError(limited ? rateLimitText(raw) : `${raw}${hint}`);
      setStreaming(false);
      setAgentStatus('');
    }
  };

  /** 停止 Agent：作废当前代次、中断正在执行的远程命令、按「跳过」结束待确认项 */
  const stopAgent = () => {
    reqGenRef.current += 1;
    const runningTool = activeToolRef.current;
    activeToolRef.current = null;
    if (runningTool) void agentCancel(runningTool).catch(() => {});
    const pending = approvalRef.current;
    approvalRef.current = null;
    setApproval(null);
    if (pending) pending(false);
    setStreaming(false);
    setAgentStatus('');
    setMessages((ms) => {
      const idx = ms.length - 1;
      if (idx < 0 || ms[idx].role !== 'assistant') return ms;
      const next = [...ms];
      next[idx] = {
        ...next[idx],
        content: next[idx].content
          ? `${next[idx].content}\n\n（已手动停止）`
          : '（已手动停止）',
      };
      return next;
    });
  };

  const send = async (override?: string) => {
    const text = (override ?? input).trim();
    if (!text || streaming) return;
    if (!activeProfile) {
      setError('请先在顶部配置并选择一个 AI 模型');
      setConfigOpen(true);
      return;
    }
    if (mode === 'agent') {
      await runAgent(text);
      return;
    }
    const userMsg: AiMessage = { role: 'user', content: text, id: nextMsgId() };
    let next = [...messages, userMsg];
    // 超出上限时裁剪最旧消息，并确保裁剪后仍以用户消息开头（符合对话 API 习惯）
    if (next.length > MAX_MESSAGES) {
      next = next.slice(-MAX_MESSAGES);
      while (next.length > 0 && next[0].role !== 'user') next.shift();
    }
    setMessages([...next, { role: 'assistant', content: '', id: nextMsgId() }]);
    setInput('');
    setError('');
    setStreaming(true);

    const cfg = activeProfile.config;
    // 请求代次：stopStreaming 之后用户可以立刻发新问题，而本轮的
    // aiChatStream await 仍未结束。等它 settle 时，cleanupListeners /
    // setStreaming 会把**新请求**的 reqId 与状态一起清掉 ——
    // 之后按"停止生成"停掉的是错误的请求。
    const myGen = ++reqGenRef.current;
    const isCurrent = () => myGen === reqGenRef.current;
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
      if (isCurrent()) reqIdRef.current = null;
    };

    /**
     * 跑一次完整的流式请求（每次重试都换新的 request id 与监听器）。
     * 失败时抛给外层，由外层决定「限流退避重试」还是「结束并提示」。
     */
    const streamOnce = async () => {
      const reqId = makeId();
      reqIdRef.current = reqId;
      acc = '';
      unChunk = await listen<string>(`ai-chunk-${reqId}`, (e) => {
        if (!isCurrent()) return;
        acc += e.payload;
        updateLastAssistant(acc);
      });
      // 两次 await 之间组件可能已经卸载（关闭面板）：此时上面的清理函数
      // 已经跑完、unlistenRef 已清空，再 push 进去的监听器将**永远不会被移除**，
      // 变成持续对已卸载组件 setState 的常驻监听。
      if (!aliveRef.current) {
        unChunk();
        return;
      }
      unDone = await listen(`ai-done-${reqId}`, () => {
        if (!isCurrent()) return;
        cleanupListeners();
        setStreaming(false);
      });
      if (!aliveRef.current) {
        cleanupListeners();
        return;
      }
      unlistenRef.current.push(unChunk, unDone);
      await aiChatStream(reqId, cfg, next);
    };

    for (let attempt = 0; ; attempt++) {
      try {
        await streamOnce();
        return;
      } catch (e) {
        cleanupListeners();
        if (!isCurrent()) return;
        // 限流：自动退避重试（最多 2 次），期间在回答气泡里倒计时。
        // 中转平台对未实名账号的 RPM 很低，比把 429 直接甩给用户友好得多。
        if (isRateLimitError(e) && attempt < 2) {
          let wait = Math.min(retryAfterSecs(e) * (attempt + 1), 60);
          while (wait > 0) {
            if (!isCurrent()) return;
            setStreaming(true);
            updateLastAssistant(`接口限流，${wait} 秒后自动重试（${attempt + 1}/2）…`);
            await sleep(1000);
            wait -= 1;
          }
          updateLastAssistant('');
          setStreaming(true);
          continue;
        }
        const msg = isRateLimitError(e) ? rateLimitText(String(e)) : String(e);
        setStreaming(false);
        updateLastAssistant(acc ? `${acc}\n\n（请求中断：${msg}）` : `（请求失败：${msg}）`);
        setError(msg);
        return;
      }
    }
  };

  // 停止生成：通知后端置位取消标志（断开上游连接），并立即结束本地流式状态。
  // 同一时刻只有一个请求在流式（send 有 streaming 守卫），清空全部监听器是安全的。
  const stopStreaming = () => {
    if (!streaming) return;
    if (mode === 'agent') {
      stopAgent();
      return;
    }
    const id = reqIdRef.current;
    if (id) void aiChatCancel(id).catch(() => {});
    // 作废本代：旧请求的 await 结束后不再有权改动界面状态
    reqGenRef.current += 1;
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
    // 弹窗打开后延迟聚焦第一个输入域，确保输入框可见。
    // 定时器必须留句柄：卸载后它仍会触发，而 .modal-backdrop 是全局选择器，
    // 可能命中别的弹窗（如连接对话框）的输入框。
    if (focusTimerRef.current !== null) window.clearTimeout(focusTimerRef.current);
    focusTimerRef.current = window.setTimeout(() => {
      focusTimerRef.current = null;
      if (!aliveRef.current) return;
      const firstInput = document.querySelector(
        '.modal-backdrop .field:first-child input',
      ) as HTMLInputElement | null;
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
    // Number('abc') 是 NaN，会一路序列化到 IPC 里变成 null，再作为非法
    // temperature 交给模型接口。这里直接拦下并给出明确提示。
    const parseNum = (raw: string): number | undefined | null => {
      if (!raw.trim()) return undefined;
      const n = Number(raw);
      return Number.isFinite(n) ? n : null;
    };
    const temperature = parseNum(editing.temperature);
    if (temperature === null) {
      setError('温度必须是数字');
      return;
    }
    const maxTokens = parseNum(editing.maxTokens);
    if (maxTokens === null) {
      setError('最大 Token 数必须是数字');
      return;
    }
    setSaving(true);
    const config: AiConfig = {
      baseUrl,
      apiKey: editing.apiKey.trim(),
      model,
      temperature,
      maxTokens,
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
          <button
            className="icon-btn"
            title="清空对话"
            disabled={streaming}
            onClick={() => {
              setMessages([]);
              setError('');
            }}
          >
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

      <div className="ai-modebar">
        <div className="ai-mode-tabs">
          <button
            className={`ai-mode-tab${mode === 'chat' ? ' active' : ''}`}
            disabled={streaming}
            onClick={() => setMode('chat')}
            title="普通对话：只生成文本，不会在服务器上执行任何命令"
          >
            对话
          </button>
          <button
            className={`ai-mode-tab${mode === 'agent' ? ' active' : ''}`}
            disabled={streaming}
            onClick={() => setMode('agent')}
            title="Agent：可在当前服务器自动执行命令、读取输出、写入脚本"
          >
            Agent
          </button>
        </div>
        <span className="ai-spacer" />
        {mode === 'agent' && (
          <label
            className="ai-autorun"
            title="关闭后，每次执行命令 / 写脚本前都会先弹出确认；高危命令始终会被后端拦截"
          >
            <input
              type="checkbox"
              checked={autoRun}
              disabled={streaming}
              onChange={(e) => setAutoRun(e.target.checked)}
            />
            自动执行
          </label>
        )}
      </div>

      {mode === 'agent' && !sessionId && (
        <div className="ai-agent-warn">
          当前标签不是 SSH 终端，Agent 没有可执行的服务器。请切换到已连接的 SSH 标签。
        </div>
      )}

      <div className="ai-chat" ref={chatRef}>
        {messages.length === 0 && (
          <div className="host-empty">
            <p>{mode === 'agent' ? 'Agent · 自动运维' : '与 AI 模型对话'}</p>
            <p className="host-empty-sub">
              {mode === 'agent'
                ? '描述目标即可，Agent 会自己执行命令、读结果、写脚本'
                : '可提问、让 AI 生成命令、或点「引用输出」把终端最近输出交给它分析'}
            </p>
            {mode === 'agent' && (
              <div className="ai-quick">
                {[
                  '检查磁盘和 inode 占用，找出最大的几个目录',
                  '查看系统负载，找出占用 CPU / 内存最高的进程',
                  '写一个日志清理脚本到 ~/cleanup_logs.sh，保留最近 7 天',
                  '检查 nginx 是否正常，分析最近的错误日志',
                ].map((q) => (
                  <button
                    key={q}
                    className="ai-quick-item"
                    onClick={() => void send(q)}
                  >
                    {q}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        {messages.map((m, mi) => {
          const isLast = mi === messages.length - 1;
          if (m.role === 'user') {
            return (
              <div className="ai-msg ai-msg-user" key={m.id}>
                <div className="ai-bubble">{m.content}</div>
              </div>
            );
          }
          const rounds = m.rounds ?? [];
          const empty = m.content === '';
          const showTyping = empty && (rounds.length === 0 || (isLast && streaming));
          return (
            <div className="ai-msg ai-msg-ai" key={m.id}>
              {rounds.length > 0 && (
                <div className="ai-tool-list">
                  {rounds.map((r, ri) => (
                    <div className="ai-round" key={`${m.id}-r${ri}`}>
                      {r.content && <div className="ai-round-note">{r.content}</div>}
                      {r.toolCalls.map((c) => (
                        <AgentToolCard
                          key={c.id}
                          call={c}
                          result={r.results.find((x) => x.toolCallId === c.id)}
                        />
                      ))}
                    </div>
                  ))}
                </div>
              )}
              {showTyping ? (
                <div className="ai-bubble ai-typing">
                  {isLast && mode === 'agent' && agentStatus ? agentStatus : '思考中…'}
                </div>
              ) : empty ? null : (
                <div className="ai-bubble">{m.content}</div>
              )}
            </div>
          );
        })}
      </div>

      <div className="ai-input-row">
        {approval && (
          <div className="ai-approval">
            <div className="ai-approval-head">{approval.title}</div>
            <pre className="ai-approval-detail">{approval.detail}</pre>
            <div className="ai-approval-actions">
              <span className="ai-spacer" />
              <button className="mini-btn" onClick={() => resolveApproval(false)}>
                跳过
              </button>
              <button className="btn primary" onClick={() => resolveApproval(true)}>
                允许执行
              </button>
            </div>
          </div>
        )}
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
          placeholder={
            !activeProfile
              ? '请先配置模型'
              : mode === 'agent'
                ? '告诉 Agent 要做什么，它会自动执行命令 / 写脚本；Enter 发送'
                : '输入你的问题，Enter 发送，Shift+Enter 换行'
          }
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
            {streaming
              ? mode === 'agent'
                ? '执行中…'
                : '生成中…'
              : mode === 'agent'
                ? '执行'
                : '发送'}
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

/** Agent 的一次工具调用卡片：命令 / 路径 / 输出 / 脚本内容 */
function AgentToolCard({ call, result }: { call: AiToolCall; result?: AiToolResult }) {
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
    },
    [],
  );

  const args = parseToolArgs(call.function.arguments);
  const isScript = call.function.name === 'write_script';
  const command = typeof args.command === 'string' ? args.command : '';
  const path = typeof args.path === 'string' ? args.path : '';
  const description = typeof args.description === 'string' ? args.description : '';
  const script =
    result?.script ?? (typeof args.content === 'string' ? args.content : '');
  const status = !result ? 'running' : result.skipped ? 'skipped' : result.ok ? 'ok' : 'fail';
  const statusText =
    status === 'running'
      ? '执行中'
      : status === 'skipped'
        ? '已跳过'
        : status === 'ok'
          ? result?.exitCode !== undefined
            ? `exit ${result.exitCode}`
            : '成功'
          : result?.exitCode !== undefined
            ? `exit ${result.exitCode}`
            : '失败';
  const output = result?.output ?? '';
  const long = output.length > 600 || output.split('\n').length > 14;

  const copyScript = () => {
    void writeText(script)
      .then(() => {
        setCopied(true);
        if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
        copyTimerRef.current = window.setTimeout(() => {
          copyTimerRef.current = null;
          setCopied(false);
        }, 1500);
      })
      .catch(() => {
        /* 剪贴板不可用时静默忽略 */
      });
  };

  return (
    <div className={`ai-tool ai-tool-${status === 'running' ? 'pending' : status}`}>
      <div className="ai-tool-head">
        <span className="ai-tool-icon" aria-hidden="true">
          {isScript ? (
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <path d="M14 2v6h6M9 15h6M9 11h2" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="m4 17 6-6-6-6M12 19h8" />
            </svg>
          )}
        </span>
        <span className="ai-tool-name">{call.function.name}</span>
        <span className={`ai-tool-status ai-tool-status-${status}`}>{statusText}</span>
      </div>

      {command && <pre className="ai-tool-cmd">$ {command}</pre>}
      {path && <div className="ai-tool-path">{path}</div>}
      {description && <div className="ai-tool-desc">{description}</div>}

      {isScript && script && (
        <details className="ai-tool-script">
          <summary>
            查看脚本（{script.split('\n').length} 行 · {script.length} 字符）
          </summary>
          <pre>{script}</pre>
          <button className="mini-btn" onClick={copyScript}>
            {copied ? '已复制' : '复制脚本'}
          </button>
        </details>
      )}

      {output &&
        (long ? (
          <details className="ai-tool-output" open={status !== 'ok'}>
            <summary>输出（{output.length} 字符）</summary>
            <pre>{output}</pre>
          </details>
        ) : (
          <pre className="ai-tool-output-pre">{output}</pre>
        ))}

      {!result && <div className="ai-tool-running">执行中…</div>}
    </div>
  );
}
