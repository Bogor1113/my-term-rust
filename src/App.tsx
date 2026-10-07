import { useCallback, useEffect, useRef, useState } from 'react';
import ResourceMonitor from './components/ResourceMonitor';
import Sidebar from './components/Sidebar';
import GroupManager from './components/GroupManager';
import ConnectionModal, { type ConnectConfig } from './components/ConnectionModal';
import TerminalTab from './components/TerminalTab';
import ClusterPanel from './components/ClusterPanel';
import SessionPicker from './components/SessionPicker';
import SftpPanel from './components/SftpPanel';
import SnippetsPanel from './components/SnippetsPanel';
import ForwardPanel from './components/ForwardPanel';
import SplitPicker from './components/SplitPicker';
import AIPanel from './components/AIPanel';
import ErrorBoundary from './components/ErrorBoundary';
import Modal from './components/Modal';
import TitleBar from './components/TitleBar';
import { bytesToBase64, listSessions, sftpHome, sendInput } from './api';
import type { SavedHost, SessionSummary, TabInfo } from './types';
import { TERM_THEMES, applyTermTheme, getSavedThemeId, isLightTheme } from './themes';
import './styles.css';

const HOSTS_KEY = 'myterm.hosts';
const SIDEBAR_KEY = 'myterm.sidebar';
const GROUPS_KEY = 'myterm.groups';
const SPLIT_RATIO_KEY = 'myterm.splitRatio';

/** 读取持久化的分屏比例（0.15~0.85，非法值回退 0.5） */
function loadSplitRatio(): number {
  try {
    const raw = localStorage.getItem(SPLIT_RATIO_KEY);
    if (!raw) return 0.5;
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0.15 && n <= 0.85) return n;
  } catch {
    /* 忽略 */
  }
  return 0.5;
}

function makeId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function loadGroups(): string[] {
  try {
    const raw = localStorage.getItem(GROUPS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((g): g is string => typeof g === 'string' && g.trim().length > 0)
      .map((g) => g.trim());
  } catch {
    return [];
  }
}

function loadHosts(): SavedHost[] {
  try {
    const raw = localStorage.getItem(HOSTS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const valid = parsed.filter(
      (item: unknown): item is SavedHost =>
        typeof item === 'object' &&
        item !== null &&
        typeof (item as Record<string, unknown>).id === 'string' &&
        typeof (item as Record<string, unknown>).name === 'string' &&
        typeof (item as Record<string, unknown>).host === 'string' &&
        typeof (item as Record<string, unknown>).port === 'number' &&
        typeof (item as Record<string, unknown>).username === 'string' &&
        typeof (item as Record<string, unknown>).password === 'string',
    );
    // 历史数据去重：host+port+username 相同的连接只保留最后一条，避免遗留重复项
    const seen = new Set<string>();
    const deduped: SavedHost[] = [];
    for (let i = valid.length - 1; i >= 0; i--) {
      const key = `${valid[i].host}:${valid[i].port}:${valid[i].username}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.unshift(valid[i]);
    }
    return deduped;
  } catch {
    return [];
  }
}

/** 解析终端 cd 的目标路径 */
function resolveCdPath(
  arg: string | undefined,
  cwd: string,
  home: string,
  prevCwd?: string | undefined,
): string | null {
  if (!arg) return home; // cd 不带参数 → home
  if (arg === '-') {
    // cd - → 回到前一目录（OLDPWD）；无记录则不导航
    return prevCwd || null;
  }
  if (arg.startsWith('/')) return normalizePath(arg);
  if (arg === '~') return home;
  if (arg.startsWith('~/')) return normalizePath(home + arg.slice(1));
  return normalizePath(joinPath(cwd, arg));
}

function joinPath(a: string, b: string): string {
  return a.endsWith('/') ? a + b : a + '/' + b;
}

function normalizePath(p: string): string {
  const parts = p.split('/');
  const out: string[] = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (out.length > 0) out.pop();
      continue;
    }
    out.push(part);
  }
  return '/' + out.join('/');
}

export default function App() {
  const [hosts, setHosts] = useState<SavedHost[]>(loadHosts);
  const [tabs, setTabs] = useState<TabInfo[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [editingHost, setEditingHost] = useState<SavedHost | null>(null);
  const [sftpOpen, setSftpOpen] = useState(false);
  // 命令片段面板（右侧抽屉）
  const [snippetsOpen, setSnippetsOpen] = useState(false);
  // 端口转发面板（右侧抽屉）
  const [forwardOpen, setForwardOpen] = useState(false);
  // AI 助手面板（右侧抽屉）
  const [aiOpen, setAiOpen] = useState(false);
  // 多会话广播输入：开启后输入复制到所有 SSH 会话
  const [broadcast, setBroadcast] = useState(false);
  // 集群监控：目标会话选择器（选择已连接的 SSH 会话后创建 cluster 标签）
  const [clusterPickerOpen, setClusterPickerOpen] = useState(false);
  // 集群监控打开前置检查的提示信息（在选择器内展示）
  const [clusterNotice, setClusterNotice] = useState<string | null>(null);
  const [connectedSessions, setConnectedSessions] = useState<SessionSummary[]>([]);
  // 左侧服务器列表展开状态：每次打开应用都默认显示，忽略上次的收起记忆
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(true);
  // 终端配色主题（持久化 + 广播给所有终端）
  const [themeId, setThemeId] = useState<string>(getSavedThemeId);
  // 标签页右键菜单（复制会话 / 关闭标签）
  const [tabMenu, setTabMenu] = useState<{
    x: number;
    y: number;
    tabId: string;
  } | null>(null);
  const tabMenuRef = useRef<HTMLDivElement>(null);
  // 主题选择弹出菜单（右上角调色板图标触发）
  const [themeMenu, setThemeMenu] = useState<{ x: number; y: number } | null>(null);
  const themeMenuRef = useRef<HTMLDivElement>(null);
  const tabbarRef = useRef<HTMLDivElement>(null);
  // 点击已激活标签时的重新聚焦信号（递增触发 TerminalTab 重新 focus）
  const [focusTick, setFocusTick] = useState(0);
  // 删除服务器确认弹窗（替换原生 window.confirm）
  const [deleteHost, setDeleteHost] = useState<SavedHost | null>(null);
  // 分组管理弹窗 + 显式分组列表（含空分组）
  const [groupManagerOpen, setGroupManagerOpen] = useState(false);
  const [groups, setGroups] = useState<string[]>(loadGroups);
  // 左右分屏：右面板显示的标签 id（null = 未分屏）
  const [splitPartnerId, setSplitPartnerId] = useState<string | null>(null);
  // 分屏时焦点所在的面板：true = 左面板（激活/活跃标签）、false = 右面板
  const [splitFocusedLeft, setSplitFocusedLeft] = useState(true);
  // 左面板宽度占比（0.15 ~ 0.85），分隔条拖拽调整；比例偏好跨启动记忆
  const [splitRatio, setSplitRatio] = useState<number>(loadSplitRatio);
  // 分屏选择第二标签的弹窗
  const [splitPickerOpen, setSplitPickerOpen] = useState(false);

  // SFTP 导航请求（一次性：由终端 cd 触发，消费后清除）
  const [navReq, setNavReq] = useState<{ path: string; nonce: number } | null>(null);

  // 每个会话的 home 与当前目录
  const homeDirRef = useRef<Record<string, string>>({});
  const cwdDirRef = useRef<Record<string, string>>({});
  const prevCwdRef = useRef<Record<string, string>>({});
  // 待提交的 OLDPWD：cd 发起时先暂存，面板成功加载目标目录后才提交到
  /// prevCwdRef（导航失败不污染，保证 `cd -` 始终跳到真实上一个目录）
  const pendingPrevRef = useRef<Record<string, string>>({});
  // 提示符跟踪：每个会话最近一次导航的目录 / 挂起的 ~ 路径
  const lastNavCwdRef = useRef<Record<string, string>>({});
  const pendingCwdRef = useRef<Record<string, string>>({});
  // 最新 activeId 与 sftpOpen（供异步回调校验）
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  const sftpOpenRef = useRef(sftpOpen);
  sftpOpenRef.current = sftpOpen;

  useEffect(() => {
    try {
      localStorage.setItem(HOSTS_KEY, JSON.stringify(hosts));
    } catch {
      /* 存储失败时忽略 */
    }
  }, [hosts]);

  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_KEY, sidebarOpen ? '1' : '0');
    } catch {
      /* 存储失败时忽略 */
    }
  }, [sidebarOpen]);

  useEffect(() => {
    try {
      localStorage.setItem(GROUPS_KEY, JSON.stringify(groups));
    } catch {
      /* 存储失败时忽略 */
    }
  }, [groups]);

  // 分屏比例偏好持久化（partnerId/焦点是会话级状态：重启后 SSH 会话已断开，
  // 标签必然不存在，无需也无法恢复；只有分割比例值得记住）
  useEffect(() => {
    try {
      localStorage.setItem(SPLIT_RATIO_KEY, String(splitRatio));
    } catch {
      /* 存储失败时忽略 */
    }
  }, [splitRatio]);

  // 新增分组（自动去重）
  const addGroup = (name: string) => {
    const n = name.trim();
    if (!n) return;
    setGroups((gs) => (gs.includes(n) ? gs : [...gs, n]));
  };

  // 重命名分组：更新分组列表，并把该组下所有主机的 group 一并改名
  const renameGroup = (oldName: string, newName: string) => {
    const oldN = oldName.trim();
    const newN = newName.trim();
    if (!oldN || !newN || oldN === newN) return;
    setGroups((gs) => gs.map((g) => (g === oldN ? newN : g)));
    setHosts((hs) =>
      hs.map((h) => (h.group && h.group.trim() === oldN ? { ...h, group: newN } : h)),
    );
  };

  // 删除分组：从列表移除，并把该组下所有主机移回「未分组」
  const deleteGroup = (name: string) => {
    const n = name.trim();
    if (!n) return;
    setGroups((gs) => gs.filter((g) => g !== n));
    setHosts((hs) =>
      hs.map((h) => (h.group && h.group.trim() === n ? { ...h, group: '' } : h)),
    );
  };

  // 直接给某台主机设置分组（侧栏下拉快速调整）
  const setHostGroup = (id: string, group: string) => {
    const g = group.trim();
    if (g) addGroup(g);
    setHosts((hs) => hs.map((h) => (h.id === id ? { ...h, group: g } : h)));
  };

  // 全局拦截 webview 原生右键菜单（其中的「刷新」会重载页面导致所有连接断开）
  // 以及 F5 / Ctrl+R / Ctrl+Shift+R 刷新快捷键。终端内的右键粘贴由 TerminalTab 处理。
  useEffect(() => {
    const onCtx = (e: MouseEvent) => e.preventDefault();
    const onKey = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if (e.key === 'F5') e.preventDefault();
      if ((e.ctrlKey || e.metaKey) && k === 'r') e.preventDefault();
    };
    document.addEventListener('contextmenu', onCtx);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('contextmenu', onCtx);
      document.removeEventListener('keydown', onKey);
    };
  }, []);

  // 明亮主题联动：终端选择浅色主题时，UI 外壳（侧边栏/标签栏/面板）跟随切换
  useEffect(() => {
    document.documentElement.dataset.theme = isLightTheme(themeId) ? 'light' : 'dark';
  }, [themeId]);

  const pickTheme = (id: string) => {
    setThemeId(id);
    applyTermTheme(id);
  };

  // 标签过多时（标签栏滚动条隐藏）切换标签后自动滚动，确保激活标签在可视区
  useEffect(() => {
    const bar = tabbarRef.current;
    if (!bar) return;
    const el = bar.querySelector<HTMLElement>('.tab.active');
    if (!el) return;
    const left = el.offsetLeft;
    const right = left + el.offsetWidth;
    if (left < bar.scrollLeft) {
      bar.scrollTo({ left, behavior: 'smooth' });
    } else if (right > bar.scrollLeft + bar.clientWidth) {
      bar.scrollTo({ left: right - bar.clientWidth, behavior: 'smooth' });
    }
  }, [activeId, tabs.length]);

  // 标签栏鼠标滚轮 → 水平滚动（仅内容溢出时生效，浏览器标签页体验）。
  // 用原生监听 + passive:false，React 的 onWheel 无法可靠阻止默认滚动行为。
  useEffect(() => {
    const bar = tabbarRef.current;
    if (!bar) return;
    const onWheel = (e: WheelEvent) => {
      if (bar.scrollWidth - bar.clientWidth <= 0) return; // 未溢出不拦截
      e.preventDefault();
      bar.scrollLeft += Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    };
    bar.addEventListener('wheel', onWheel, { passive: false });
    return () => bar.removeEventListener('wheel', onWheel);
  }, []);

  const openSession = (cfg: ConnectConfig) => {
    const id = makeId();
    setTabs((ts) => [
      ...ts,
      {
        id,
        kind: 'ssh',
        host: cfg.host,
        port: cfg.port,
        username: cfg.username,
        password: cfg.password,
      },
    ]);
    setActiveId(id);
    setSftpOpen(false);
  };

  // 打开集群监控标签：弹出已连接会话选择器
  const openClusterPicker = useCallback(() => {
    setClusterNotice(null);
    void listSessions()
      .then((sessions) => {
        // 仅列出仍处于连接状态的会话
        setConnectedSessions(sessions.filter((s) => s.status === 'connected'));
      })
      .catch(() => setConnectedSessions([]));
    setClusterPickerOpen(true);
  }, []);

  // 基于已连接会话创建集群监控标签。
  // 打开前两道检测：
  // ① 集群监控全局只允许一个标签——同会话已开则直接激活；
  //    不同会话已开则提示先关闭（避免多个轮询任务叠加打爆 SSH/JMX）。
  // ② 再次确认所选会话仍处于连接状态（选择器弹出后可能已断开）。
  const openClusterTab = (session: SessionSummary) => {
    const existing = tabs.find((t) => t.kind === 'cluster');
    if (existing) {
      if (existing.sessionId === session.id) {
        // 同一台主机：直接切换到现有集群标签
        setActiveId(existing.id);
        setSftpOpen(false);
        setClusterPickerOpen(false);
      } else {
        setClusterNotice(
          `已在监控 ${existing.host}，请先关闭该集群监控标签再监控其他主机`,
        );
      }
      return;
    }
    void listSessions()
      .then((sessions) => {
        const cur = sessions.find((s) => s.id === session.id);
        if (!cur || cur.status !== 'connected') {
          setClusterNotice('该会话已断开，无法打开集群监控');
          return;
        }
        const id = makeId();
        setTabs((ts) => [
          ...ts,
          {
            id,
            kind: 'cluster',
            host: session.host,
            port: session.port,
            username: session.username,
            password: '',
            sessionId: session.id,
          },
        ]);
        setActiveId(id);
        setSftpOpen(false);
        setClusterPickerOpen(false);
        setClusterNotice(null);
      })
      .catch(() => setClusterNotice('检测会话状态失败，请重试'));
  };

  const closeTab = (id: string) => {
    const idx = tabs.findIndex((t) => t.id === id);
    setTabs((ts) => ts.filter((t) => t.id !== id));
    setActiveId((cur) => {
      // 关闭的不是当前激活标签 → 保持不变
      if (cur !== id) return cur;
      // 关闭的是当前标签 → 默认激活右侧（后面）的标签，没有则激活左侧（前面）的
      const after = tabs[idx + 1];
      if (after) return after.id;
      const before = tabs[idx - 1];
      return before ? before.id : null;
    });
    // 清理 ref
    delete homeDirRef.current[id];
    delete cwdDirRef.current[id];
    delete prevCwdRef.current[id];
    delete pendingPrevRef.current[id];
    delete lastNavCwdRef.current[id];
    delete pendingCwdRef.current[id];
    // 若关闭的是右侧分屏标签，则退出分屏
    if (splitPartnerId === id) setSplitPartnerId(null);
  };

  // 分屏保持一致性：总是 一个标签在聚焦面板（activeId）、一个在另一面板（splitPartnerId），
  // 两者必须不同且都存在。例外（关闭标签后激活回退、集群标签被关闭）触发时退出分屏。
  useEffect(() => {
    if (!splitPartnerId) return;
    const partnerExists = tabs.some((t) => t.id === splitPartnerId);
    const activeExists = activeId !== null && tabs.some((t) => t.id === activeId);
    if (!partnerExists || !activeExists || splitPartnerId === activeId) {
      setSplitPartnerId(null);
      setSplitFocusedLeft(true);
      setSplitRatio(0.5);
    }
  }, [splitPartnerId, activeId, tabs]);

  // 分屏：返回某面板当前展示的标签 id（中轴以 splitFocusedLeft 定位）
  const paneTab = useCallback(
    (side: 'left' | 'right'): string | null => {
      if (splitFocusedLeft) return side === 'left' ? activeId : splitPartnerId;
      return side === 'left' ? splitPartnerId : activeId;
    },
    [splitFocusedLeft, activeId, splitPartnerId],
  );

  // 点击面板 / 点击该面板的标签头 → 聚焦该面板（布局完全不动，仅焦点与激活标签变化）
  const focusPane = useCallback(
    (side: 'left' | 'right') => {
      const id = paneTab(side);
      if (!id || id === activeId) return;
      const other = activeId;
      setActiveId(id);
      setSplitPartnerId(other);
      setSplitFocusedLeft(side === 'left');
    },
    [paneTab, activeId],
  );

  // 交换左右面板内容（聚焦侧不变，聚焦面板随之显示另一标签）
  const swapSplit = useCallback(() => {
    if (!splitPartnerId) return;
    setActiveId(splitPartnerId);
    setSplitPartnerId(activeId);
  }, [activeId, splitPartnerId]);

  // 拖拽分隔条调整左右宽度
  const splitAreaRef = useRef<HTMLDivElement>(null);
  const draggingSplitRef = useRef(false);
  const startSplitDrag = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    draggingSplitRef.current = true;
    const move = (ev: PointerEvent) => {
      if (!draggingSplitRef.current || !splitAreaRef.current) return;
      const r = splitAreaRef.current.getBoundingClientRect();
      if (r.width <= 0) return;
      const ratio = Math.min(0.85, Math.max(0.15, (ev.clientX - r.left) / r.width));
      setSplitRatio(ratio);
    };
    const up = () => {
      draggingSplitRef.current = false;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }, []);

  // 快捷键：分屏时 Alt + ←/→ 切换聚焦面板（捕获阶段拦截，避免传给 shell）。
  // 焦点在普通输入控件内时不劫持（避免打断表单编辑）；注意 xterm 的隐藏
  // textarea 也是 TEXTAREA——终端内必须保持拦截（Alt+方向键会变成 shell 转义序列）。
  useEffect(() => {
    if (!splitPartnerId) return;
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === 'INPUT' ||
          (t.tagName === 'TEXTAREA' && t.closest('.xterm') === null))
      ) {
        return;
      }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        e.stopPropagation();
        focusPane(e.key === 'ArrowLeft' ? 'left' : 'right');
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [splitPartnerId, focusPane]);

  // 兜底修复连续快速关闭标签的竞态：closeTab 里激活目标是基于闭包中的
  // tabs 计算的，两次关闭落在同一批次时，第一次算出的目标可能正是第二个
  // 也被关闭的标签，导致 activeId 指向不存在的标签。这里在每次标签列表
  // 变化后校验 activeId，失效则回退到最后一个剩余标签。
  useEffect(() => {
    setActiveId((cur) => {
      if (cur !== null && tabs.some((t) => t.id === cur)) return cur;
      return tabs.length > 0 ? tabs[tabs.length - 1].id : null;
    });
  }, [tabs]);

  // 复制会话：用相同凭据再开一个标签（双击标签或右键菜单触发）
  const duplicateTab = (id: string) => {
    const t = tabs.find((x) => x.id === id);
    if (!t || t.kind !== 'ssh') return; // 集群监控标签不可复制
    openSession({
      name: t.username,
      host: t.host,
      port: t.port,
      username: t.username,
      password: t.password,
    });
  };

  // 标签右键菜单：点击外部 / Esc / 滚动时关闭
  useEffect(() => {
    if (!tabMenu) return;
    const onDown = (e: PointerEvent) => {
      const el = tabMenuRef.current;
      if (el && e.target instanceof Node && el.contains(e.target)) return;
      setTabMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setTabMenu(null);
    };
    const onScroll = () => setTabMenu(null);
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    document.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('scroll', onScroll, true);
    };
  }, [tabMenu]);

  // 主题选择菜单：点击外部 / Esc / 滚动时关闭
  useEffect(() => {
    if (!themeMenu) return;
    const onDown = (e: PointerEvent) => {
      const el = themeMenuRef.current;
      if (el && e.target instanceof Node && el.contains(e.target)) return;
      setThemeMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setThemeMenu(null);
    };
    const onScroll = () => setThemeMenu(null);
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    document.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('scroll', onScroll, true);
    };
  }, [themeMenu]);

  const activeTab = tabs.find((t) => t.id === activeId) ?? null;

  // 任务栏/窗口标题显示当前连接，多会话时便于辨认
  useEffect(() => {
    document.title = activeTab
      ? `${activeTab.username}@${activeTab.host}${activeTab.kind === 'ssh' ? `:${activeTab.port}` : ' · 集群监控'} - MyTerm`
      : 'MyTerm';
  }, [activeTab]);

  // 所有 SSH 会话标签的 id（广播 / 片段发送的目标）
  const sshTabIds = tabs.filter((t) => t.kind === 'ssh').map((t) => t.id);
  // 广播模式下 TerminalTab 输入的目标 id 列表（含源终端自身）
  const broadcastTargets = broadcast && sshTabIds.length > 1 ? sshTabIds : [];

  // 发送一段命令：广播开启则复制到所有 SSH 会话，否则发到当前激活的 SSH 会话
  const sendCommand = useCallback(
    (command: string) => {
      const targets =
        broadcast && sshTabIds.length > 1
          ? sshTabIds
          : activeId && sshTabIds.includes(activeId)
            ? [activeId]
            : [];
      if (targets.length === 0) return;
      const encoder = new TextEncoder();
      const b64 = bytesToBase64(encoder.encode(command + '\r'));
      for (const id of targets) {
        void sendInput(id, b64).catch(() => {});
      }
    },
    [broadcast, sshTabIds, activeId],
  );

  // 终端 cd 命令 → 导航 SFTP 面板（sessionId 为发出 cd 的会话）
  const handleCd = useCallback(
    async (sessionId: string, arg: string) => {
      let home: string | undefined = homeDirRef.current[sessionId];
      // home 未知（SFTP 面板未打开过）时尝试实时获取
      if (!home) {
        try {
          home = await sftpHome(sessionId);
          homeDirRef.current[sessionId] = home;
        } catch {
          home = undefined;
        }
      }
      // 相对路径 / ~ 需要 home 才能正确解析，取不到则跳过同步
      if (!home && arg !== '~' && !arg.startsWith('/') && !arg.startsWith('~/')) {
        return;
      }
      const baseHome = home || '/';
      const cwd = cwdDirRef.current[sessionId] || baseHome;
      const target = resolveCdPath(arg, cwd, baseHome, prevCwdRef.current[sessionId]);
      if (!target) return;
      // 异步等待期间用户可能已切换标签，避免导航到错误的会话面板
      if (sessionId !== activeIdRef.current) return;
      // 记录前一个目录；仅当面板成功加载目标目录后（onPathLoaded）才
      // 提交为 OLDPWD，避免 cd 敲错路径后污染 `cd -` 的目标
      pendingPrevRef.current[sessionId] = cwd;
      setNavReq((prev) => ({ path: target, nonce: (prev?.nonce ?? 0) + 1 }));
      // 如果 SFTP 未打开，则自动打开
      if (!sftpOpenRef.current) setSftpOpen(true);
    },
    [],
  );

  // 提示符解析到的 shell 当前目录（权威 cwd 来源）→ 更新跟踪并导航面板。
  // cd 成功 → 新提示符路径变化 → 导航；cd 敲错 → 提示符不变 → 不导航。
  const handleCwdChange = useCallback((id: string, raw: string) => {
    const home = homeDirRef.current[id];
    let cwd: string;
    if (raw === '~') {
      if (!home) {
        pendingCwdRef.current[id] = raw;
        return;
      }
      cwd = home;
    } else if (raw.startsWith('~/')) {
      if (!home) {
        pendingCwdRef.current[id] = raw;
        return;
      }
      cwd = home + raw.slice(1);
    } else if (raw.startsWith('/')) {
      cwd = raw;
    } else {
      return; // 无法识别的提示符路径，忽略
    }
    cwdDirRef.current[id] = cwd;
    delete pendingCwdRef.current[id];
    const last = lastNavCwdRef.current[id];
    if (cwd !== last) {
      lastNavCwdRef.current[id] = cwd;
      // 仅当面板已打开且会话处于激活状态时导航（不自动打开面板）
      if (activeIdRef.current === id && sftpOpenRef.current) {
        setNavReq((prev) => ({ path: cwd, nonce: (prev?.nonce ?? 0) + 1 }));
      }
    }
  }, []);

  // SFTP 面板 / 终端获取到 home 目录后记录，并补解析之前缺 home 挂起的提示符路径
  const handleHomeReady = useCallback(
    (id: string, home: string) => {
      homeDirRef.current[id] = home;
      const pend = pendingCwdRef.current[id];
      if (pend) handleCwdChange(id, pend);
    },
    [handleCwdChange],
  );

  // cd 导航请求已被 SFTP 面板消费
  const handleNavConsumed = useCallback(() => setNavReq(null), []);

  // SFTP 面板成功加载目录 → 提交该次 cd 导航的 OLDPWD（`cd -` 依赖）
  const handlePathLoaded = useCallback((id: string, _path: string) => {
    const prev = pendingPrevRef.current[id];
    if (prev !== undefined) {
      prevCwdRef.current[id] = prev;
      delete pendingPrevRef.current[id];
    }
  }, []);

  // 渲染一个标签页的面板：cluster → 集群监控；ssh → 终端。
  // 所有标签统一放进 .term-view（absolute 定位）：
  // ① 保证非激活的 SSH 终端的 absolute 盒子不会盖在集群面板上；② 分屏 flex 布局时只占位不挤压。
  // splitPane 表示分屏中作为右面板显示（inactive 但可见、可交互）。
  const renderTab = (t: TabInfo, active: boolean, hidden = false, splitPane = false) => {
    const viewClass = `term-view${active ? '' : ' inactive'}${hidden ? ' term-hidden' : ''}${splitPane ? ' term-split-shown' : ''}`;
    return (
      <ErrorBoundary key={t.id}>
        {t.kind === 'cluster' ? (
          <div className={viewClass}>
            <ClusterPanel tab={t} active={active} splitPane={splitPane} />
          </div>
        ) : (
          <TerminalTab
            tab={t}
            active={active}
            hidden={hidden}
            splitPane={splitPane}
            focusTick={focusTick}
            onCdCommand={handleCd}
            onHomeReady={handleHomeReady}
            onCwdChange={handleCwdChange}
            broadcastTargets={broadcastTargets}
          />
        )}
      </ErrorBoundary>
    );
  };

  return (
    <div className="app">
      <TitleBar />
      <div className="workspace">
        <Sidebar
          hosts={hosts}
          collapsed={!sidebarOpen}
          onToggle={() => setSidebarOpen((v) => !v)}
          onConnect={(h) =>
            openSession({
              name: h.name,
              host: h.host,
              port: h.port,
              username: h.username,
              password: h.password,
            })
          }
          onEdit={(h) => {
            setEditingHost(h);
            setShowModal(true);
          }}
          onDelete={(id) => setDeleteHost(hosts.find((x) => x.id === id) ?? null)}
          onNew={() => {
            setEditingHost(null);
            setShowModal(true);
          }}
          onClusterClick={openClusterPicker}
          groups={groups}
          onManageGroups={() => setGroupManagerOpen(true)}
          onSetGroup={setHostGroup}
        />

        <div className="main">
          <div className="tabbar">
            <div className="tabbar-scroll" ref={tabbarRef}>
              {tabs.map((t) => (
                <div
                  key={t.id}
                  className={`tab ${t.id === activeId ? 'active' : ''}`}
                  onClick={() => {
                    if (t.id === activeId) {
                      setFocusTick((n) => n + 1);
                    } else if (splitPartnerId === t.id) {
                      // 点击另一面板的标签头 → 聚焦到它所在的面板（布局不动）
                      focusPane(splitFocusedLeft ? 'right' : 'left');
                      setFocusTick((n) => n + 1);
                    } else {
                      // 其它标签 → 载入当前聚焦的面板，分屏保持不变
                      setActiveId(t.id);
                      setFocusTick((n) => n + 1);
                    }
                  }}
                  onDoubleClick={() => duplicateTab(t.id)}
                  onAuxClick={(e) => {
                    if (e.button === 1) {
                      e.preventDefault();
                      closeTab(t.id);
                    }
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setTabMenu({ x: e.clientX, y: e.clientY, tabId: t.id });
                  }}
                  title={
                    t.kind === 'cluster'
                      ? '集群监控标签'
                      : '双击或右键可复制会话，中键关闭'
                  }>
                  <span className={`tab-dot${t.kind === 'cluster' ? ' cluster' : ''}`} />
                  <span className="tab-title">
                    {t.kind === 'cluster'
                      ? `集群监控 · ${t.username}@${t.host}`
                      : `${t.username}@${t.host}:${t.port}`}
                  </span>
                  <button
                    className="tab-close"
                    title="关闭标签"
                    onClick={(e) => {
                      e.stopPropagation();
                      closeTab(t.id);
                    }}
                    onDoubleClick={(e) => e.stopPropagation()}
                  >
                    <svg
                      viewBox="0 0 24 24"
                      width="12"
                      height="12"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.2"
                      strokeLinecap="round"
                    >
                      <path d="M6 6l12 12M18 6L6 18" />
                    </svg>
                  </button>
                </div>
              ))}
              <button
                className="tab-new"
                title="新建连接"
                onClick={() => {
                  setEditingHost(null);
                  setShowModal(true);
                }}
              >
                <svg
                  viewBox="0 0 24 24"
                  width="15"
                  height="15"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                >
                  <path d="M12 5v14M5 12h14" />
                </svg>
              </button>
            </div>

            <div className="tabbar-right">
              {sshTabIds.length > 1 && (
                <button
                  className={`broadcast-toggle ${broadcast ? 'on' : ''}`}
                  onClick={() => setBroadcast((v) => !v)}
                  title={
                    broadcast
                      ? `广播输入中（将复制到 ${sshTabIds.length} 个会话）`
                      : '广播输入：同时向所有会话发送相同命令'
                  }
                >
                  <svg
                    viewBox="0 0 24 24"
                    width="15"
                    height="15"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <circle cx="12" cy="12" r="2" />
                    <path d="M7.6 7.6a6 6 0 0 0 0 8.8M16.4 7.6a6 6 0 0 1 0 8.8M4.9 4.9a10 10 0 0 0 0 14.2M19.1 4.9a10 10 0 0 1 0 14.2" />
                  </svg>
                </button>
              )}
              <button
                className={`sftp-toggle ${forwardOpen ? 'on' : ''}`}
                onClick={() => setForwardOpen((v) => !v)}
                title="端口转发"
              >
                <svg
                  viewBox="0 0 24 24"
                  width="15"
                  height="15"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M9 11l6-6M14 3h3v3M5 16l-2 2M14 14l3 3M4 14l4-4 4 4-4 4Z" />
                </svg>
              </button>
              <button
                className={`sftp-toggle ${aiOpen ? 'on' : ''}`}
                onClick={() => setAiOpen((v) => !v)}
                title="AI 助手"
              >
                <svg
                  viewBox="0 0 24 24"
                  width="15"
                  height="15"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M12 3l1.6 4.2L18 9l-4.4 1.8L12 15l-1.6-4.2L6 9l4.4-1.8L12 3Z" />
                  <path d="M18.5 14l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9.9-2.1Z" />
                </svg>
              </button>
              {tabs.length >= 2 && (
              <button
                className={`sftp-toggle ${splitPartnerId ? 'on' : ''}`}
                onClick={() => {
                  if (splitPartnerId) {
                    setSplitPartnerId(null);
                    setSplitFocusedLeft(true);
                    setSplitRatio(0.5);
                  } else {
                    setSplitPickerOpen(true);
                  }
                }}
                title={
                  splitPartnerId ? '关闭分屏' : '左右分屏：选择第二个标签并排显示'
                }
              >
                <svg
                  viewBox="0 0 24 24"
                  width="15"
                  height="15"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <rect x="3" y="4" width="8" height="16" rx="1.5" />
                  <rect x="13" y="4" width="8" height="16" rx="1.5" />
                </svg>
              </button>
              )}
              {splitPartnerId && (
                <button
                  className="sftp-toggle"
                  onClick={swapSplit}
                  title="交换左右面板"
                >
                  <svg
                    viewBox="0 0 24 24"
                    width="15"
                    height="15"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M8 8H3l3-3M8 16H3l3 3M16 16h5l-3-3M16 8h5l-3 3" />
                  </svg>
                </button>
              )}
              <button
                className={`sftp-toggle ${snippetsOpen ? 'on' : ''}`}
                onClick={() => setSnippetsOpen((v) => !v)}
                title="命令片段"
              >
                <svg
                  viewBox="0 0 24 24"
                  width="15"
                  height="15"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M8 6l-5 6 5 6M16 6l5 6-5 6M13.5 4l-3 16" />
                </svg>
              </button>
              <button
                className={`sidebar-toggle ${sidebarOpen ? 'on' : ''}`}
                onClick={() => setSidebarOpen((v) => !v)}
                title="服务器列表"
              >
                <svg
                  viewBox="0 0 24 24"
                  width="15"
                  height="15"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinejoin="round"
                >
                  <rect x="3" y="4" width="18" height="7" rx="2" />
                  <rect x="3" y="13" width="18" height="7" rx="2" />
                  <path d="M7 7.5h.01M7 16.5h.01" strokeLinecap="round" />
                </svg>
              </button>
              <button
                className="theme-btn"
                title="终端配色主题"
                onClick={(e) => {
                  const r = e.currentTarget.getBoundingClientRect();
                  setThemeMenu({ x: r.right - 180, y: r.bottom + 6 });
                }}
              >
                <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor">
                  <path d="M12 3a9 9 0 1 0 0 18h1.2a1.8 1.8 0 0 0 1.3-3.1 1.8 1.8 0 0 1 1.3-3H18a3 3 0 0 0 3-3 6 6 0 0 0-9-5.9ZM8 13.5a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Zm4-4a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Zm4 1a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Z" />
                </svg>
              </button>
              {activeTab && activeTab.kind === 'ssh' && (
                <button
                  className={`sftp-toggle ${sftpOpen ? 'on' : ''}`}
                  onClick={() => setSftpOpen((v) => !v)}
                  title="SFTP 文件管理"
                >
                  <svg
                    viewBox="0 0 24 24"
                    width="15"
                    height="15"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinejoin="round"
                  >
                    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
                  </svg>
                </button>
              )}
            </div>
          </div>

          <div className={`terminal-area${splitPartnerId ? ' split' : ''}`} ref={splitAreaRef}>
            {tabs.length === 0 && (
              <div className="empty-state">
                <div className="empty-logo">
                  <svg
                    viewBox="0 0 24 24"
                    width="46"
                    height="46"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.3"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <rect x="2.5" y="4" width="19" height="16" rx="2.5" />
                    <path d="M6.5 9l3.5 3-3.5 3M12.5 15h5" />
                  </svg>
                </div>
                <h1>myterm-波哥自研</h1>
                <p>远程 SSH 终端 · SFTP 文件管理 · 系统资源监控</p>
                <button
                  className="btn primary"
                  onClick={() => {
                    setEditingHost(null);
                    setShowModal(true);
                  }}
                >
                  新建连接
                </button>
              </div>
            )}
            {splitPartnerId && activeTab ? (
              (() => {
                const partnerTab = tabs.find((t) => t.id === splitPartnerId) ?? null;
                // 另一面板标签已不存在（被关闭等）→ 回退单标签视图（effect 随即清空 splitPartnerId）
                if (!partnerTab) {
                  return tabs.map((t) => renderTab(t, t.id === activeId));
                }
                const leftTab = splitFocusedLeft ? activeTab : partnerTab;
                const rightTab = splitFocusedLeft ? partnerTab : activeTab;
                const leftPct = splitRatio * 100;
                const rightPct = 100 - leftPct;
                const paneStyle = (pct: number): React.CSSProperties => ({
                  flex: `0 0 calc(${pct}% - 2px)`,
                });
                // 点击面板空白/内容区 → 聚焦该面板；点击按钮、输入控件等
                // 交互元素时不切换焦点（避免服务启停/YARN 终止等操作被打断）
                const paneClick =
                  (side: 'left' | 'right') => (e: React.MouseEvent) => {
                    const el = e.target as HTMLElement | null;
                    if (el && el.closest('button, input, select, textarea, label')) return;
                    focusPane(side);
                  };
                return (
                  <>
                    <div
                      className={`split-pane${splitFocusedLeft ? ' split-focused' : ''}`}
                      style={paneStyle(leftPct)}
                      onClick={paneClick('left')}
                    >
                      {renderTab(leftTab, leftTab.id === activeId, false, true)}
                    </div>
                    <div className="split-divider" onPointerDown={startSplitDrag} />
                    <div
                      className={`split-pane${splitFocusedLeft ? '' : ' split-focused'}`}
                      style={paneStyle(rightPct)}
                      onClick={paneClick('right')}
                    >
                      {renderTab(rightTab, rightTab.id === activeId, false, true)}
                    </div>
                    {tabs
                      .filter((t) => t.id !== splitPartnerId && t.id !== activeId)
                      .map((t) => renderTab(t, false, true))}
                  </>
                );
              })()
            ) : (
              tabs.map((t) => renderTab(t, t.id === activeId))
            )}
          </div>
        </div>

        {sftpOpen && activeTab && activeTab.kind === 'ssh' && (
          <ErrorBoundary>
            <SftpPanel
              tab={activeTab}
              onClose={() => setSftpOpen(false)}
              navReq={navReq}
              onNavConsumed={handleNavConsumed}
              onHomeReady={handleHomeReady}
              onPathLoaded={handlePathLoaded}
            />
          </ErrorBoundary>
        )}

        {snippetsOpen && (
          <ErrorBoundary>
            <SnippetsPanel onClose={() => setSnippetsOpen(false)} onSend={sendCommand} />
          </ErrorBoundary>
        )}

        {forwardOpen && (
          <ErrorBoundary>
            <ForwardPanel
              sessions={connectedSessions}
              onClose={() => setForwardOpen(false)}
            />
          </ErrorBoundary>
        )}

        {aiOpen && (
          <ErrorBoundary>
            <AIPanel
              sessionId={activeTab?.kind === 'ssh' ? activeId : null}
              onClose={() => setAiOpen(false)}
            />
          </ErrorBoundary>
        )}
      </div>

      <ErrorBoundary>
        <ResourceMonitor
          sessionId={activeTab?.kind === 'cluster' ? activeTab.sessionId ?? null : activeId}
          host={activeTab ? `${activeTab.username}@${activeTab.host}` : undefined}
        />
      </ErrorBoundary>

      {/* 标签页右键菜单（复制会话 / 关闭标签） */}
      {tabMenu && (
        <div
          className="ctx-menu"
          ref={tabMenuRef}
          style={{
            left: Math.max(0, Math.min(tabMenu.x, window.innerWidth - 180)),
            top: Math.max(0, Math.min(tabMenu.y, window.innerHeight - 130)),
          }}
        >
          <div
            className="ctx-menu-item"
            onClick={() => {
              const id = tabMenu.tabId;
              setTabMenu(null);
              duplicateTab(id);
            }}
          >
            <svg
              viewBox="0 0 24 24"
              width="14"
              height="14"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="9" y="9" width="11" height="11" rx="2" />
              <path d="M5 15V5a2 2 0 0 1 2-2h10" />
            </svg>
            复制会话
          </div>
          <div
            className="ctx-menu-item danger"
            onClick={() => {
              const id = tabMenu.tabId;
              setTabMenu(null);
              closeTab(id);
            }}
          >
            <svg
              viewBox="0 0 24 24"
              width="14"
              height="14"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.9"
              strokeLinecap="round"
            >
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
            关闭标签
          </div>
        </div>
      )}

      {/* 主题选择弹出菜单（右上角调色板图标触发） */}
      {themeMenu && (
        <div
          className="theme-menu"
          ref={themeMenuRef}
          style={{
            left: Math.max(8, Math.min(themeMenu.x, window.innerWidth - 190)),
            top: Math.max(8, Math.min(themeMenu.y, window.innerHeight - 290)),
          }}
        >
          {TERM_THEMES.map((t) => (
            <div
              key={t.id}
              className={`theme-menu-item${t.id === themeId ? ' sel' : ''}`}
              onClick={() => {
                pickTheme(t.id);
                setThemeMenu(null);
              }}
            >
              <span className="theme-swatch" style={{ background: t.theme.background }} />
              {t.name}
            </div>
          ))}
        </div>
      )}

      {clusterPickerOpen && (
        <SessionPicker
          sessions={connectedSessions}
          message={clusterNotice ?? undefined}
          onPick={(id) => {
            const s = connectedSessions.find((x) => x.id === id);
            if (s) openClusterTab(s);
          }}
          onClose={() => {
            setClusterPickerOpen(false);
            setClusterNotice(null);
          }}
        />
      )}

      {splitPickerOpen && (
        <SplitPicker
          tabs={tabs.filter((t) => t.id !== activeId)}
          onPick={(id) => {
            setSplitPartnerId(id);
            setSplitFocusedLeft(true);
            setSplitRatio(0.5);
            setSplitPickerOpen(false);
          }}
          onClose={() => setSplitPickerOpen(false)}
        />
      )}

      {showModal && (
        <ConnectionModal
          initial={editingHost}
          onClose={() => {
            setShowModal(false);
            setEditingHost(null);
          }}
          onSubmit={(cfg, persist) => {
            if (editingHost) {
              // 编辑已有服务器
              setHosts((hs) =>
                hs.map((h) => (h.id === editingHost.id ? { ...h, ...cfg } : h)),
              );
            } else if (persist) {
              setHosts((hs) => {
                // 相同 host+port+username 视为同一台服务器：覆盖已有项（保留原 id），
                // 不新增重复连接
                const idx = hs.findIndex(
                  (h) =>
                    h.host === cfg.host &&
                    h.port === cfg.port &&
                    h.username === cfg.username,
                );
                if (idx >= 0) {
                  const next = [...hs];
                  next[idx] = { ...next[idx], ...cfg };
                  return next;
                }
                return [...hs, { id: makeId(), ...cfg }];
              });
            }
            openSession(cfg);
            setShowModal(false);
            setEditingHost(null);
          }}
        />
      )}

      {/* 删除服务器确认弹窗 */}
      {deleteHost && (
        <Modal
          title="删除服务器"
          message={
            <>
              确定从列表中删除服务器「<span className="conflict-name">{deleteHost.name}</span>
              」吗？
              <br />
              <span className="conflict-path">
                {deleteHost.username}@{deleteHost.host}:{deleteHost.port}
              </span>
            </>
          }
          confirmText="删除"
          danger
          onClose={() => setDeleteHost(null)}
          onConfirm={() => {
            setHosts((hs) => hs.filter((h) => h.id !== deleteHost.id));
            setDeleteHost(null);
          }}
        />
      )}

      {/* 分组管理弹窗 */}
      {groupManagerOpen && (
        <GroupManager
          groups={groups}
          hosts={hosts}
          onAddGroup={addGroup}
          onRenameGroup={renameGroup}
          onDeleteGroup={deleteGroup}
          onClose={() => setGroupManagerOpen(false)}
        />
      )}
    </div>
  );
}