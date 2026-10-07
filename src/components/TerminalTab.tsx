// ---------- 类型、导入等 ----------
import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal } from 'xterm';
import type { IDecoration, ITerminalOptions } from 'xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { openUrl } from '@tauri-apps/plugin-opener';
import { readText, writeText } from '@tauri-apps/plugin-clipboard-manager';
import 'xterm/css/xterm.css';
import {
  base64ToBytes,
  bytesToBase64,
  connectSsh,
  disconnectSsh,
  resizePty,
  sendInput,
  sftpHome,
} from '../api';
import type { TabInfo } from '../types';
import {
  THEME_EVENT,
  computeSelectionOpaque,
  getThemeById,
  loadTermTheme,
} from '../themes';


type Status = 'connecting' | 'connected' | 'closed' | 'error';

interface Props {
  tab: TabInfo;
  active: boolean;
  /** 是否强制隐藏（分屏时非左右面板的其它标签用 hidden 隐藏但保持挂载以维持连接） */
  hidden?: boolean;
  /** 分屏模式下作为右面板显示（inactive 但仍可见、可交互、可点击交换焦点） */
  splitPane?: boolean;
  /** 点击已激活标签时的重新聚焦信号（递增触发重新 focus） */
  focusTick?: number;
  /** 终端检测到 cd 命令时的回调（sessionId + cd 后的参数字符串，空串表示裸 cd） */
  onCdCommand?: (sessionId: string, arg: string) => void;
  /** 连接建立后查询到的远程 home 目录 */
  onHomeReady?: (sessionId: string, home: string) => void;
  /** 从 shell 提示符解析出的当前目录（权威 cwd 来源） */
  onCwdChange?: (sessionId: string, cwd: string) => void;
  /** 广播模式下的目标会话 id 列表（含自身）；为空表示未开启广播 */
  broadcastTargets?: string[];
}

/** 去除 ANSI 转义序列（颜色 / 光标 / OSC 等），用于从输出中解析命令回显 */
function stripAnsi(s: string): string {
  return s
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '') // OSC
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '') // CSI（颜色 / 光标）
    .replace(/\u001b[()][0-9A-Z]/g, '') // 字符集
    .replace(/\u001b[=>78]/g, ''); // 其他单字符 ESC
}

// ---------- 字体缩放（Ctrl + 滚轮） ----------
const FONT_SIZE_KEY = 'myterm.fontSize';
const MIN_FONT = 9;
const MAX_FONT = 28;
const DEFAULT_FONT = 13;

function loadFontSize(): number {
  try {
    const v = Number(localStorage.getItem(FONT_SIZE_KEY));
    if (Number.isFinite(v) && v >= MIN_FONT && v <= MAX_FONT) return v;
  } catch {
    /* 存储不可用时忽略 */
  }
  return DEFAULT_FONT;
}

// ---------- 关键词高亮集 ----------
// 对终端可见输出中的错误 / 警告 / 成功关键词叠加高亮底色（纯展示，不改动原始数据）
const HIGHLIGHT_RULES: {
  label: string;
  regex: RegExp;
  fg: string;
  bg: string;
}[] = [
  {
    label: 'error',
    regex:
      /\b(error|errors?|fatal|failed|failure|exception|traceback|denied|refused|cannot|unable|panic|segmentation fault|拒绝|失败|错误|异常)\b/gi,
    fg: '#ff6b6b',
    bg: 'rgba(255,60,60,0.22)',
  },
  {
    label: 'warn',
    regex:
      /\b(warn|warning|warnings|deprecated|timeout|timed out|slow|注意|警告|超时|已弃用)\b/gi,
    fg: '#ffb454',
    bg: 'rgba(255,165,40,0.20)',
  },
  {
    label: 'ok',
    regex:
      /\b(success|succeeded|ok|done|completed|finished|exit 0|成功|完成)\b/gi,
    fg: '#4cd46b',
    bg: 'rgba(45,205,95,0.18)',
  },
];

export default function TerminalTab({
  tab,
  active,
  hidden = false,
  splitPane = false,
  focusTick,
  onCdCommand,
  onHomeReady,
  onCwdChange,
  broadcastTargets,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const disposedRef = useRef(false);
  const activeRef = useRef(active);
  // 广播目标（含自身）；通过 ref 让静态闭包读取最新值
  const broadcastRef = useRef<string[]>(broadcastTargets ?? []);
  broadcastRef.current = broadcastTargets ?? [];
  // 行缓冲：累计用户按键直到 Enter，用于检测 cd 命令
  const inputBufRef = useRef('');
  // 转义序列累积（方向键 / Home 等以 \x1b 开头的序列，可能跨 data 事件）
  const escSeqRef = useRef('');
  // 输出行解析的状态（跨重连保留，重连时重置）
  const echoBufRef = useRef('');
  const echoDecoderRef = useRef(new TextDecoder('utf-8'));
  const onHomeReadyRef = useRef(onHomeReady);
  onHomeReadyRef.current = onHomeReady;
  const onCwdChangeRef = useRef(onCwdChange);
  onCwdChangeRef.current = onCwdChange;
  // 是否已成功解析出提示符（解析成功则禁用按键检测导航，避免 cd 敲错时误导航）
  const promptSeenRef = useRef(false);
  const [status, setStatus] = useState<Status>('connecting');
  const [error, setError] = useState('');
  // 终端内搜索浮层
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchText, setSearchText] = useState('');
  const [searchCase, setSearchCase] = useState(false);
  const [searchRegex, setSearchRegex] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  // 自动重连状态：定时器与已尝试次数（退避重试）
  const reconnectRef = useRef<{ timer: number | null; attempts: number }>({
    timer: null,
    attempts: 0,
  });
  const [reconnecting, setReconnecting] = useState(false);
  const [reconnectAttempts, setReconnectAttempts] = useState(0);
  // 手动重连冷却：防止连续点击「重试」触发连接风暴
  const [retryCooldown, setRetryCooldown] = useState(0);
  const lastManualRetryRef = useRef(0);
  // ---------- 输出缓冲背压：防止高速输出导致 xterm 内部缓冲无限增长 ----------
  // 后端已将数据合并为低频大消息，这里再按帧节流写入 xterm，并丢弃积压旧数据。
  const MAX_PENDING_BYTES = 2 * 1024 * 1024; // 待写入缓冲上限 2MB
  const WRITE_CHUNK_BYTES = 64 * 1024; // 每帧最多喂给 xterm 的字节数
  const pendingBufRef = useRef<Uint8Array[]>([]); // 待写入块队列
  const pendingSizeRef = useRef(0); // 待写入总字节数
  const flushingRef = useRef(false); // 是否正在执行 rAF 刷新
  const needReflushRef = useRef(false); // 刷新期间又来了新数据，需再刷一次
  // 关键词高亮：当前活动装饰集 + 防抖定时器
  const hlDecorationsRef = useRef<Set<IDecoration>>(new Set());
  const hlTimerRef = useRef<number | null>(null);

  const setStatusSafe = (s: Status) => {
    if (!disposedRef.current) setStatus(s);
  };

  // 把一段输出写入 xterm，并对其尾部做 cd 回显检测（只处理最新 64KB，避免逐帧解析开销）
  const flushPending = () => {
    const chunks = pendingBufRef.current;
    if (chunks.length === 0) {
      flushingRef.current = false;
      return;
    }
    const total = pendingSizeRef.current;
    pendingBufRef.current = [];
    pendingSizeRef.current = 0;

    // 合并所有待写块为单个字节数组
    const merged = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      merged.set(c, off);
      off += c.length;
    }

    // 输出回显 cd 检测（兜底信号）：只解析最新 64KB，避免高频输出拖慢解析
    if (merged.length > 0) {
      const tailLen = Math.min(merged.length, 64 * 1024);
      processOutput(merged.subarray(merged.length - tailLen));
    }

    // 分块写入 xterm（带回调链，避免一次性塞入超大缓冲导致 xterm 内部积压）
    const term = termRef.current;
    if (!term) {
      flushingRef.current = false;
      return;
    }
    let pos = 0;
    const writeNext = () => {
      if (pos >= merged.length) {
        // 写入完成才释放「刷新中」锁，避免并发写链
        flushingRef.current = false;
        scheduleHighlightRefresh();
        // 写入期间又有新数据到来 → 安排下一次刷新
        if (needReflushRef.current) {
          needReflushRef.current = false;
          scheduleFlush();
        }
        return;
      }
      const end = Math.min(pos + WRITE_CHUNK_BYTES, merged.length);
      const chunk = merged.subarray(pos, end);
      // 先推进 pos 再写入 xterm，防止 term.write 同步回调时
      // 以旧的 pos 再次创建同一块数据写入，导致双击回显
      pos = end;
      term.write(chunk, writeNext);
    };
    writeNext();
  };

  // 安排一次 rAF 刷新（若正在刷新则标记 needReflush）
  const scheduleFlush = () => {
    if (flushingRef.current) {
      needReflushRef.current = true;
      return;
    }
    flushingRef.current = true;
    requestAnimationFrame(flushPending);
  };

  // 收到后端输出：入队并丢弃积压旧数据，然后安排刷新
  const enqueueOutput = (bytes: Uint8Array) => {
    pendingBufRef.current.push(bytes);
    pendingSizeRef.current += bytes.length;
    // 超过上限 → 丢弃最旧块，保留最新输出
    while (
      pendingSizeRef.current > MAX_PENDING_BYTES &&
      pendingBufRef.current.length > 0
    ) {
      const dropped = pendingBufRef.current.shift()!;
      pendingSizeRef.current -= dropped.length;
    }
    scheduleFlush();
  };

  // 重建当前视口内可见行的关键词高亮装饰（先清除旧装饰，再按规则叠加）
  const refreshHighlights = () => {
    const term = termRef.current;
    if (!term || disposedRef.current) return;
    for (const d of hlDecorationsRef.current) {
      try {
        d.dispose();
      } catch {
        /* 忽略 */
      }
    }
    hlDecorationsRef.current.clear();
    const buf = term.buffer.active;
    const start = buf.viewportY;
    const end = Math.min(start + term.rows, buf.length);
    const cursorAbs = buf.viewportY + buf.cursorY;
    for (let row = start; row < end; row++) {
      const line = buf.getLine(row);
      if (!line) continue;
      const text = line.translateToString(true);
      if (!text) continue;
      for (const rule of HIGHLIGHT_RULES) {
        rule.regex.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = rule.regex.exec(text)) !== null) {
          const marker = term.registerMarker(row - cursorAbs);
          const deco = term.registerDecoration({
            marker,
            x: m.index,
            width: m[0].length,
            layer: 'top',
            backgroundColor: rule.bg,
            foregroundColor: rule.fg,
          });
          if (deco) hlDecorationsRef.current.add(deco);
          if (m.index === rule.regex.lastIndex) rule.regex.lastIndex++;
        }
      }
    }
  };

  // 防抖触发高亮刷新（写入 / 滚动 / 渲染后调用，避免高频重建装饰）
  const scheduleHighlightRefresh = () => {
    if (hlTimerRef.current !== null) return;
    hlTimerRef.current = window.setTimeout(() => {
      hlTimerRef.current = null;
      refreshHighlights();
    }, 120);
  };

  // 适配终端尺寸并通知后端
  const fitTerminal = useCallback(() => {
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term || !fit) return;
    try {
      fit.fit();
      void resizePty(tab.id, term.cols, term.rows).catch(() => {});
    } catch {
      /* 容器暂不可见时忽略 */
    }
  }, [tab.id]);

  // 发送输入：广播开启时复制到所有目标会话，否则仅发送到当前会话
  const sendToRemote = useCallback(
    (b64: string) => {
      const targets = broadcastRef.current;
      if (targets.length > 0) {
        for (const id of targets) {
          void sendInput(id, b64).catch(() => {});
        }
      } else {
        void sendInput(tab.id, b64).catch(() => {});
      }
    },
    [tab.id],
  );

  // 截断 cd 参数中的命令链（&& / ; / |），忽略引号内的分隔符
  const extractCdArg = useCallback((arg: string): string => {
    let quote: string | null = null;
    for (let i = 0; i < arg.length; i++) {
      const ch = arg[i];
      if (quote) {
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === '&' || ch === ';' || ch === '|') {
        return arg.slice(0, i).trim();
      }
    }
    return arg.trim();
  }, []);

  // 检测行中是否包含 cd 命令，返回参数（去掉「cd」后的部分，空串表示裸 cd）
  const detectCd = useCallback(
    (line: string): string | null => {
      const trimmed = line.trim();
      // 匹配 cd 开头命令：支持 cd、cd ~、cd /path、cd ../path、cd（回到 home）
      const m = trimmed.match(/^cd(?:\s+(.+))?$/);
      if (!m) return null;
      const raw = m[1] ? extractCdArg(m[1]) : '';
      // 去掉简单引号，并清理 Tab 等控制字符（tab 补全会混入 \t）
      const clean = raw
        .replace(/^"(.+)"$/, '$1')
        .replace(/^'(.+)'$/, '$1')
        .replace(/[\x00-\x1f\x7f]/g, '');
      // 提示符可解析时，导航以提示符跟踪为准（避免 cd 敲错导致误导航）
      if (!promptSeenRef.current) {
        onCdCommand?.(tab.id, clean);
      }
      return clean;
    },
    [extractCdArg, onCdCommand, tab.id],
  );

  // 从输出行解析 shell 提示符中的当前目录（user@host:path# / user@host:path$）。
  // 提示符是 shell 真实 cwd 的权威来源：cd 成功 → 新提示符路径变化 → 导航；
  // cd 敲错 → 提示符不变 → 不导航。面板独立浏览不影响该跟踪。
  const handleOutputLine = useCallback(
    (line: string) => {
      if (!line) return;
      const m = line.match(/^[^\s@]+@[^:\s]+:(.*?)([#$])(?:\s.*)?$/);
      if (!m) return;
      const raw = (m[1] || '').trim();
      if (!raw) return;
      promptSeenRef.current = true;
      onCwdChangeRef.current?.(tab.id, raw);
    },
    [tab.id],
  );

  // 把输出分块解码、去 ANSI、按行切分后交给提示符解析
  const processOutput = useCallback(
    (chunk: Uint8Array) => {
      const text = echoDecoderRef.current.decode(chunk, { stream: true });
      // 对合并后的整段去 ANSI，避免跨分块的转义序列残留
      let buf = stripAnsi(echoBufRef.current + text);
      // 防内存膨胀：若服务器持续输出无换行内容（如 \r 进度条），
      // 只保留最近 64KB，避免 echoBuf 无限增长
      const MAX_ECHO_BUF = 64 * 1024;
      if (buf.length > MAX_ECHO_BUF) {
        buf = buf.slice(-MAX_ECHO_BUF);
      }
      echoBufRef.current = '';
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).replace(/\r+$/, '').trim();
        buf = buf.slice(nl + 1);
        handleOutputLine(line);
      }
      echoBufRef.current = buf;
    },
    [handleOutputLine],
  );

  // 停止自动重连，回到手动重连状态（保持当前 closed / error 状态不变）
  const stopReconnect = useCallback(() => {
    if (reconnectRef.current.timer !== null) {
      window.clearTimeout(reconnectRef.current.timer);
      reconnectRef.current.timer = null;
    }
    reconnectRef.current.attempts = 0;
    setReconnectAttempts(0);
    setReconnecting(false);
  }, []);

  // 建立（或重连）SSH 会话；异常断开后按指数退避自动重连
  const connect = useCallback(() => {
    const term = termRef.current;
    if (!term || disposedRef.current) return;
    // 清理待执行的自动重连定时器
    if (reconnectRef.current.timer !== null) {
      window.clearTimeout(reconnectRef.current.timer);
      reconnectRef.current.timer = null;
    }
    setError('');
    setStatusSafe('connecting');
    echoBufRef.current = '';
    echoDecoderRef.current = new TextDecoder('utf-8');
    promptSeenRef.current = false; // 重连后重新评估提示符可解析性

    // 安排下一次重连：1s → 2s → 4s → 8s → 封顶 10s
    const scheduleNext = () => {
      const n = reconnectRef.current.attempts + 1;
      reconnectRef.current.attempts = n;
      setReconnectAttempts(n);
      setReconnecting(true);
      const delay = Math.min(1000 * 2 ** (n - 1), 10_000);
      reconnectRef.current.timer = window.setTimeout(() => {
        reconnectRef.current.timer = null;
        connect();
      }, delay);
    };

    connectSsh(tab, term.cols, term.rows, (ev) => {
      if (disposedRef.current) return;
      if (ev.type === 'data') {
        setStatusSafe('connected');
        reconnectRef.current.attempts = 0;
        setReconnecting(false);
        const bytes = base64ToBytes(ev.data);
        enqueueOutput(bytes); // 入队缓冲，由 rAF 背压节流后写入 xterm
      } else {
        setStatusSafe('closed');
        // shell 正常退出（exit）不自动重连；网络断开 / 远端关闭通道则重连
        if (ev.data.reason === 'eof') return;
        scheduleNext();
      }
    })
      .then(() => {
        if (disposedRef.current) {
          // 组件已卸载但连接此刻才建立完成 → 立即断开，避免会话泄漏
          void disconnectSsh(tab.id).catch(() => {});
          return;
        }
        setStatusSafe('connected');
        reconnectRef.current.attempts = 0;
        setReconnecting(false);
        // 连接就绪后获取远程 home，供 SFTP 面板 cd 同步使用
        void sftpHome(tab.id)
          .then((home) => onHomeReadyRef.current?.(tab.id, home))
          .catch(() => {});
      })
      .catch((err) => {
        setError(String(err));
        setStatusSafe('error');
        // 处于自动重连周期中时继续退避重试；首次连接失败则停止（显示手动重试）
        if (reconnectRef.current.attempts > 0) {
          scheduleNext();
        } else {
          setReconnecting(false);
        }
      });
  }, [tab, processOutput]);

  // 手动重连冷却：2 秒内防止重复点击
  const MANUAL_RETRY_COOLDOWN = 2000;
  const handleRetry = useCallback(() => {
    const now = Date.now();
    const elapsed = now - lastManualRetryRef.current;
    if (elapsed < MANUAL_RETRY_COOLDOWN) {
      const remain = Math.ceil((MANUAL_RETRY_COOLDOWN - elapsed) / 1000);
      setRetryCooldown(remain);
      // 冷却结束后清除倒计时
      window.setTimeout(() => setRetryCooldown(0), MANUAL_RETRY_COOLDOWN - elapsed);
      return;
    }
    lastManualRetryRef.current = now;
    setRetryCooldown(0);
    connect();
  }, [connect]);

  // 初始化 xterm
  useEffect(() => {
    disposedRef.current = false;
    activeRef.current = active;
    inputBufRef.current = '';
    const container = containerRef.current;
    if (!container) return;

    // 把字号同步成 CSS 变量：xterm 注入的 <style> 在个别 WebView2 下不生效时，
    // 由 styles.css 的兑底规则用该变量保持等宽字体与字号（含 Ctrl+滚轮缩放）。
    container.style.setProperty('--term-font-size', `${loadFontSize()}px`);
    // 选区兑底同理：注入失效时由 styles.css 的 :where() 规则用该变量绘制选区背景
    const initTheme = loadTermTheme().theme;
    container.style.setProperty(
      '--term-selection-bg',
      computeSelectionOpaque(initTheme),
    );

    // xterm 5.x 支持 rendererType('canvas' | 'dom' | 'webgl'),但类型定义未暴露,
    // 用交叉类型补上该运行时选项(见 https://github.com/xtermjs/xterm.js/issues/3914 )。
    // 使用 DOM 渲染器:文字通过 CSS 颜色渲染,避免部分 WebView2 环境下
    // canvas 渲染器不绘制 ANSI 颜色的问题(其余 UI 均为 DOM/SVG,颜色正常)。
    const term = new Terminal({
      cursorBlink: true,
      fontSize: loadFontSize(),
      lineHeight: 1.15,
      fontFamily:
        '"Cascadia Code", Consolas, "JetBrains Mono", "Fira Code", Menlo, Monaco, monospace',
      theme: initTheme,
      scrollback: 6000,
      allowProposedApi: true,
      rightClickSelectsWord: false,
      rendererType: 'dom',
    } as ITerminalOptions & { rendererType: 'canvas' | 'dom' | 'webgl' });
    const fit = new FitAddon();
    term.loadAddon(fit);
    const search = new SearchAddon();
    term.loadAddon(search);
    termRef.current = term;
    fitRef.current = fit;
    searchRef.current = search;
    term.open(container);

    // URL 超链接点击（http/https/ftp）：直接调用系统默认浏览器打开
    const urlRegex = /(https?:\/\/[^\s<>"']+|ftp:\/\/[^\s<>"']+)/g;
    term.registerLinkProvider({
      provideLinks(bufferLineNumber: number, callback: (links: any) => void) {
        const line = term.buffer.active.getLine(bufferLineNumber);
        if (!line) {
          callback(undefined);
          return;
        }
        const lineStr = line.translateToString(true);
        const links: { range: any; text: string; activate: () => void }[] = [];
        let m: RegExpExecArray | null;
        urlRegex.lastIndex = 0;
        while ((m = urlRegex.exec(lineStr)) !== null) {
          const raw = m[0].replace(/[),.;:!?]+$/, '');
          if (!raw) continue;
          const startX = m.index + 1;
          const endX = startX + raw.length;
          links.push({
            range: {
              start: { x: startX, y: bufferLineNumber + 1 },
              end: { x: endX, y: bufferLineNumber + 1 },
            },
            text: raw,
            activate() {
              void openUrl(raw).catch(() => {});
            },
          });
        }
        callback(links);
      },
    });

    // Ctrl+F 打开终端内搜索浮层
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    container.addEventListener('keydown', onKey);

    // 左键选中 → 自动复制到系统剪贴板
    term.onSelectionChange(() => {
      const sel = term.getSelection();
      if (sel) {
        void writeText(sel).catch(() => {});
      }
    });

    // 滚动 → 重建可见行高亮
    term.onScroll(() => scheduleHighlightRefresh());

    // 右键 → 直接粘贴（不弹出右键菜单）
    const onCtx = (e: MouseEvent) => {
      e.preventDefault();
      term.focus();
      void readText()
        .then((text) => {
          if (text) term.paste(text);
        })
        .catch(() => {});
    };
    container.addEventListener('contextmenu', onCtx);

    // 终端输入 → 后端 + 行缓冲 cd 检测（按键全部透传，补全由远端 shell 原生处理）
    const encoder = new TextEncoder();
    // 转义序列状态：方向键 / Home / 粘贴括号等以 \x1b 开头，直到最终字节才结束
    let inEsc = false;
    term.onData((data) => {
      // 逐字符处理；每一轮重新读取缓冲（data 可能包含整行，如粘贴输入）
      let out = ''; // 发送给后端的字节
      for (let i = 0; i < data.length; i++) {
        const ch = data[i];
        const code = ch.charCodeAt(0);
        if (inEsc) {
          // 转义序列中间：累积直到最终字节或 BEL，随后原样透传。
          // ESC [ / ESC O 开头的多字节序列（方向键 / F 键 / Del 等）第二字节
          // 不是终止符，需继续累积到 0x40–0x7E 的最终字节；
          // 其它单字符转义（ESC 7 / Alt+key）两字节即结束。
          escSeqRef.current += ch;
          const seq = escSeqRef.current;
          const multiHead = seq.startsWith('\x1b[') || seq.startsWith('\x1bO');
          const done =
            ch === '\x07' ||
            (seq.length === 2 ? !multiHead : code >= 0x40 && code <= 0x7e);
          if (!done) continue;
          out += seq;
          escSeqRef.current = '';
          inEsc = false;
          continue;
        }
        if (ch === '\x1b') {
          if (i === data.length - 1) {
            // 单独的 Esc 键（事件最后一个字符）：直接透传给 shell
            out += ch;
            continue;
          }
          // 多字节序列开头（如方向键）— 进入转义序列；
          // 方向键会触发 shell 历史导航重绘当前行，本地行缓冲作废
          inEsc = true;
          escSeqRef.current = '\x1b';
          inputBufRef.current = '';
          continue;
        }
        const buf = inputBufRef.current;
        if (ch === '\r' || ch === '\n') {
          // 提交行：cd 检测 + 清空行缓冲
          detectCd(buf);
          inputBufRef.current = '';
          out += ch;
        } else if (ch === '\x7f') {
          // 退格
          inputBufRef.current = buf.slice(0, -1);
          out += ch;
        } else if (ch === '\x03') {
          // Ctrl+C — 取消当前行
          inputBufRef.current = '';
          out += ch;
        } else {
          // 其余按键原样透传；仅可打印字符计入行缓冲，
          // Tab（shell 补全）等控制字符不参与 cd 检测，避免污染命令行内容
          if (code >= 0x20 && code !== 0x7f) {
            inputBufRef.current = buf + ch;
          }
          out += ch;
        }
      }

      // 发送到后端
      if (out) {
        const b64 = bytesToBase64(encoder.encode(out));
        sendToRemote(b64);
      }
    });

    // Ctrl + 滚轮 → 放大/缩小字体（阻止浏览器整页缩放与终端缓冲滚动）
    // 用捕获阶段监听：在 xterm 视口处理滚轮之前拦截
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      e.stopPropagation(); // 阻止 xterm 视口同时滚动缓冲
      const cur = term.options.fontSize || DEFAULT_FONT;
      const next = Math.min(
        MAX_FONT,
        Math.max(MIN_FONT, cur + (e.deltaY < 0 ? 1 : -1)),
      );
      if (next === cur) return;
      term.options.fontSize = next;
      // 同步 CSS 变量，保证兑底规则下字号与 xterm 一致
      container.style.setProperty('--term-font-size', `${next}px`);
      try {
        localStorage.setItem(FONT_SIZE_KEY, String(next));
      } catch {
        /* 存储失败时忽略 */
      }
      // 字号变化后重新适配并同步远端 PTY 尺寸
      requestAnimationFrame(() => fitTerminal());
    };
    container.addEventListener('wheel', onWheel, { passive: false, capture: true });

    // 容器尺寸变化 → 适配（分屏时左右面板均需按各自宽度重新适配，
    // 因此不再依赖 active，仅在有实际尺寸时适配；display:none 无盒子不会触发）
    const ro = new ResizeObserver(() => {
      if (container.clientWidth > 0 && container.clientHeight > 0) fitTerminal();
    });
    ro.observe(container);

    requestAnimationFrame(() => {
      fitTerminal();
      connect();
    });

    return () => {
      disposedRef.current = true;
      // 卸载时清理自动重连定时器
      if (reconnectRef.current.timer !== null) {
        window.clearTimeout(reconnectRef.current.timer);
        reconnectRef.current.timer = null;
      }
      // 清理高亮定时器与装饰
      if (hlTimerRef.current !== null) {
        window.clearTimeout(hlTimerRef.current);
        hlTimerRef.current = null;
      }
      for (const d of hlDecorationsRef.current) {
        try {
          d.dispose();
        } catch {
          /* 忽略 */
        }
      }
      hlDecorationsRef.current.clear();
      ro.disconnect();
      container.removeEventListener('wheel', onWheel);
      container.removeEventListener('contextmenu', onCtx);
      container.removeEventListener('keydown', onKey);
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      searchRef.current = null;
      void disconnectSsh(tab.id).catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 标签被激活时重新适配并聚焦（切换标签后可直接输入命令，无需再点击）
  useEffect(() => {
    activeRef.current = active;
    if (active) {
      requestAnimationFrame(() => {
        fitTerminal();
        termRef.current?.focus();
      });
    }
  }, [active, fitTerminal]);

  // 点击已激活的标签 → 重新聚焦终端（用户从其他控件返回后可直接输入）
  useEffect(() => {
    if (active && focusTick) termRef.current?.focus();
  }, [focusTick, active]);

  // 搜索浮层打开时聚焦输入框；输入变化时增量查找
  useEffect(() => {
    if (searchOpen) {
      requestAnimationFrame(() => searchInputRef.current?.focus());
    }
  }, [searchOpen]);

  useEffect(() => {
    if (!searchOpen || !searchText) return;
    try {
      searchRef.current?.findNext(searchText, {
        caseSensitive: searchCase,
        regex: searchRegex,
        incremental: true,
      });
    } catch {
      /* 无匹配时忽略 */
    }
  }, [searchText, searchCase, searchRegex, searchOpen]);

  // 主题切换：App 选择后实时应用到本终端（含选区兑底变量同步）
  useEffect(() => {
    const onTheme = (e: Event) => {
      const id = (e as CustomEvent<string>).detail;
      const def = getThemeById(id);
      const term = termRef.current;
      if (term && def) term.options.theme = def.theme;
      // 选区兑底色随主题同步，保证注入失效兑底时颜色一致
      if (def) {
        containerRef.current?.style.setProperty(
          '--term-selection-bg',
          computeSelectionOpaque(def.theme),
        );
      }
    };
    window.addEventListener(THEME_EVENT, onTheme);
    return () => window.removeEventListener(THEME_EVENT, onTheme);
  }, []);

  return (
    <div className={`term-view${active ? '' : ' inactive'}${hidden ? ' term-hidden' : ''}${splitPane ? ' term-split-shown' : ''}`}>
      <div className="term-container" ref={containerRef} />
      {searchOpen && (
        <div className="term-search" onClick={(e) => e.stopPropagation()}>
          <input
            ref={searchInputRef}
            className="term-search-input"
            value={searchText}
            placeholder="搜索终端内容…"
            onChange={(e) => {
              setSearchText(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                const next = e.shiftKey ? -1 : 1;
                if (searchRef.current) {
                  try {
                    searchRef.current.findNext(searchText, {
                      caseSensitive: searchCase,
                      regex: searchRegex,
                      incremental: false,
                    });
                    if (next < 0) {
                      searchRef.current.findPrevious(searchText, {
                        caseSensitive: searchCase,
                        regex: searchRegex,
                      });
                    }
                  } catch {
                    /* 无匹配时忽略 */
                  }
                }
              } else if (e.key === 'Escape') {
                setSearchOpen(false);
              }
            }}
          />
          <button
            className="term-search-btn"
            title="上一个（Shift+Enter）"
            onClick={() => {
              try {
                searchRef.current?.findPrevious(searchText, {
                  caseSensitive: searchCase,
                  regex: searchRegex,
                });
              } catch {
                /* 忽略 */
              }
            }}
          >
            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 15l-6-6-6 6" />
            </svg>
          </button>
          <button
            className="term-search-btn"
            title="下一个（Enter）"
            onClick={() => {
              try {
                searchRef.current?.findNext(searchText, {
                  caseSensitive: searchCase,
                  regex: searchRegex,
                });
              } catch {
                /* 忽略 */
              }
            }}
          >
            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M6 9l6 6 6-6" />
            </svg>
          </button>
          <button
            className={`term-search-btn${searchCase ? ' on' : ''}`}
            title="区分大小写"
            onClick={() => setSearchCase((v) => !v)}
          >
            Aa
          </button>
          <button
            className={`term-search-btn${searchRegex ? ' on' : ''}`}
            title="正则表达式"
            onClick={() => setSearchRegex((v) => !v)}
          >
            .*
          </button>
          <button
            className="term-search-btn"
            title="关闭（Esc）"
            onClick={() => setSearchOpen(false)}
          >
            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>
      )}
      {status !== 'connected' && (
        <div className="term-overlay">
          {status === 'connecting' && (
            <div className="term-overlay-box">
              <div className="spinner" />
              <p>
                {reconnecting
                  ? `正在自动重连 ${tab.host}:${tab.port} …（第 ${reconnectAttempts} 次）`
                  : `正在连接 ${tab.host}:${tab.port} …`}
              </p>
              <p className="term-overlay-sub">以 {tab.username} 身份建立 SSH 会话</p>
            </div>
          )}
          {status === 'error' && (
            <div className="term-overlay-box term-overlay-error">
              <div className="term-overlay-title">连接失败</div>
              <p className="term-overlay-msg">{error}</p>
              {reconnecting ? (
                <>
                  <p className="term-overlay-sub">
                    正在自动重连…（第 {reconnectAttempts} 次）
                  </p>
                  <button className="btn" onClick={stopReconnect}>
                    停止自动重连
                  </button>
                </>
              ) : (
                <button
                  className="btn primary"
                  onClick={handleRetry}
                  disabled={retryCooldown > 0}
                >
                  {retryCooldown > 0 ? `重试（${retryCooldown}s）` : '重试'}
                </button>
              )}
            </div>
          )}
          {status === 'closed' && (
            <div className="term-overlay-box">
              <div className="term-overlay-title">会话已断开</div>
              <p className="term-overlay-msg">
                {tab.host}:{tab.port} 的连接已关闭
              </p>
              {reconnecting ? (
                <>
                  <p className="term-overlay-sub">
                    正在自动重连…（第 {reconnectAttempts} 次）
                  </p>
                  <button className="btn" onClick={stopReconnect}>
                    停止自动重连
                  </button>
                </>
              ) : (
                <button
                  className="btn primary"
                  onClick={handleRetry}
                  disabled={retryCooldown > 0}
                >
                  {retryCooldown > 0 ? `重新连接（${retryCooldown}s）` : '重新连接'}
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
