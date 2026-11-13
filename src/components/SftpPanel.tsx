import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { invoke } from '@tauri-apps/api/core';
import { downloadDir as getLocalDownloadDir } from '@tauri-apps/api/path';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { open, save } from '@tauri-apps/plugin-dialog';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import {
  sftpDownload,
  sftpHome,
  sftpList,
  sftpMkdir,
  sftpRemove,
  sftpRename,
  sftpResolveConflict,
  sftpUpload,
} from '../api';
import type { SftpEntry, TabInfo, TransferProgress } from '../types';
import Modal from './Modal';

interface Props {
  tab: TabInfo;
  onClose: () => void;
  /** 终端 cd 同步请求（一次性，消费后清除） */
  navReq: { path: string; nonce: number } | null;
  /** 导航请求被消费后通知 App 清除 */
  onNavConsumed: () => void;
  /** 面板可用的 home 目录就绪后上报 */
  onHomeReady: (id: string, home: string) => void;
  /** 目录加载成功后上报（App 用它确认 cd 导航，提交 OLDPWD） */
  onPathLoaded?: (id: string, path: string) => void;
  /** 打开面板时应定位到的目录（终端当前目录；未知时回退 home） */
  initialPath?: string;
  /** 查询终端此刻所在目录（面板打开时可能还没同步到 props） */
  getCurrentCwd?: (id: string) => string | undefined;
}

interface ActiveTransfer {
  key: string;
  name: string;
  type: 'upload' | 'download';
  progress: TransferProgress;
  status: 'running' | 'failed' | 'done';
  error?: string;
  /** 重试路径：upload = {localPath 本地源, remotePath 远程目标}；download = {localPath 本地目标, remotePath 远程源} */
  retry?: { localPath: string; remotePath: string };
  /** 重试时置为 true：后端自动从断点续传 */
  resuming?: boolean;
}

const ZERO_PROGRESS: TransferProgress = {
  transferred: 0,
  total: 0,
  percent: 0,
  file: null,
  files: 0,
  totalFiles: 0,
  skipped: 0,
  conflict: null,
};

/** 拖拽下载的默认本地目录（记住用户首次的选择，之后拖出面板直接下载不再询问） */
const DLDIR_KEY = 'myterm.downloadDir';

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = -1;
  do {
    v /= 1024;
    i += 1;
  } while (v >= 1024 && i < units.length - 1);
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

function formatTime(sec: number | null): string {
  if (!sec) return '—';
  const d = new Date(sec * 1000);
  const pad = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const DirIcon = (
  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round">
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
  </svg>
);

const FileIcon = (
  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round">
    <path d="M6 3h8l4 4v14H6Z" />
    <path d="M14 3v4h4" />
  </svg>
);

/** 右键菜单项图标 */
const CtxIcon = ({ path }: { path: string }) => {
  const paths: Record<string, string> = {
    open: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z',
    download: 'M12 4v12M7 11l5 5 5-5M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3',
    rename: 'M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z',
    delete: 'M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14',
    refresh: 'M21 12a9 9 0 1 1-2.6-6.4M21 3v6h-6',
    folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z M12 11v5M9.5 13.5h5',
    upload: 'M12 16V4M7 9l5-5 5 5M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3',
  };
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d={paths[path] || paths.refresh} />
    </svg>
  );
};

/** 目录文件列表子组件（React.memo 隔离传输进度更新导致的全量重渲染）。
 *  仅当 entries 或回调引用变化时重渲染，避免每 100ms 的进度事件
 *  触发整个 SFTP 面板（含文件列表）重新执行 JSX 创建与 reconciliation。 */
const SftpFileList = memo(function SftpFileList({
  entries,
  loading,
  onEnter,
  onDownload,
  onRename,
  onRemove,
  onContextMenu,
  onRowPointerDown,
}: {
  entries: SftpEntry[];
  loading: boolean;
  onEnter: (e: SftpEntry) => void;
  onDownload: (e: SftpEntry) => void;
  onRename: (e: SftpEntry) => void;
  onRemove: (e: SftpEntry) => void;
  onContextMenu: (e: React.MouseEvent, entry: SftpEntry) => void;
  /** 行上按下鼠标：交给父级识别"拖出面板下载"手势 */
  onRowPointerDown: (e: SftpEntry, ev: React.PointerEvent) => void;
}) {
  return (
    <div className="sftp-list">
      <div className="sftp-list-head">
        <span>名称</span>
        <span>大小</span>
      </div>
      {loading && (
        <div className="sftp-status">
          <div className="spinner small" />
          加载中…
        </div>
      )}
      {!loading && entries.length === 0 && (
        <div className="sftp-status">此目录为空</div>
      )}
      {!loading &&
        entries.map((e) => (
          <div
            className={`sftp-row ${e.isDir ? 'dir' : ''}`}
            key={e.path}
            onDoubleClick={() => onEnter(e)}
            onPointerDown={(ev) => onRowPointerDown(e, ev)}
            onContextMenu={(ev) => {
              ev.preventDefault();
              ev.stopPropagation();
              onContextMenu(ev, e);
            }}
            title={`${e.perms}  ${formatTime(e.mtime)}`}
          >
            <span className="sftp-name">
              <span className={`sftp-ficon ${e.isDir ? 'dir' : 'file'}`}>
                {e.isDir ? DirIcon : FileIcon}
              </span>
              <span className="sftp-fname">{e.name}</span>
            </span>
            <span className="sftp-size">{e.isDir ? '—' : formatSize(e.size)}</span>
            <span className="sftp-actions">
              {/* 文件夹同样提供下载入口：后端 sftp_download 已支持整目录递归下载，
                  此前仅靠右键菜单暴露，行内无按钮导致用户以为不支持下载文件夹 */}
              <button
                className="mini-btn"
                title={e.isDir ? '下载文件夹' : '下载'}
                onClick={() => onDownload(e)}
              >
                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 4v12M7 11l5 5 5-5" />
                  <path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
                </svg>
              </button>
              <button className="mini-btn" title="重命名" onClick={() => onRename(e)}>
                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
                </svg>
              </button>
              <button className="mini-btn danger" title="删除" onClick={() => onRemove(e)}>
                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" />
                </svg>
              </button>
            </span>
          </div>
        ))}
    </div>
  );
});

export default function SftpPanel({
  tab,
  onClose,
  navReq,
  onNavConsumed,
  onHomeReady,
  onPathLoaded,
  initialPath,
  getCurrentCwd,
}: Props) {
  // 首帧就显示已知的终端目录，避免先闪一下 "/" / home 再跳走
  const [path, setPath] = useState(initialPath || '/');
  const [entries, setEntries] = useState<SftpEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [editingPath, setEditingPath] = useState(false);
  const [pathInput, setPathInput] = useState('');
  const [transfers, setTransfers] = useState<ActiveTransfer[]>([]);
  const [dragOver, setDragOver] = useState(false);
  // 拖拽下载（拖出面板 → 下载到默认本地目录）：跟随光标的幽灵提示
  const [rowDrag, setRowDrag] = useState<{
    entry: SftpEntry;
    x: number;
    y: number;
    outside: boolean;
  } | null>(null);
  // 拖拽手势识别（ref 持有，避免高频 move 触发重渲染）
  const rowDragRef = useRef<{
    entry: SftpEntry;
    startX: number;
    startY: number;
    active: boolean;
    /** 鼠标是否仍按住（松手置 false，用于决定下载完成后是否接管为原生拖拽） */
    held: boolean;
    cleanup?: () => void;
  } | null>(null);
  // 默认下载目录（展示用；实际读取在 dragDownload 中以 ref 数据为准）
  const [dlDir, setDlDir] = useState<string>(() => {
    try {
      return localStorage.getItem(DLDIR_KEY) ?? '';
    } catch {
      return '';
    }
  });
  // 传输同名冲突队列（逐个弹出处理，避免并发冲突互相覆盖）
  const [conflictQueue, setConflictQueue] = useState<
    { requestId: string; name: string; path: string }[]
  >([]);
  // 右键上下文菜单（entry 为 null 表示空白处）
  const [ctxMenu, setCtxMenu] = useState<{
    x: number;
    y: number;
    entry: SftpEntry | null;
  } | null>(null);
  const ctxMenuRef = useRef<HTMLDivElement>(null);
  // 应用内 prompt / confirm 弹窗（替换原生 window.prompt / window.confirm）
  const [prompt, setPrompt] = useState<{
    title: string;
    label?: string;
    placeholder?: string;
    defaultValue?: string;
    selectAll?: boolean;
    onConfirm: (value: string) => void;
  } | null>(null);
  const [confirm, setConfirm] = useState<{
    title: string;
    message: string;
    confirmText?: string;
    onConfirm: () => void;
  } | null>(null);

  const panelRef = useRef<HTMLDivElement>(null);
  const pathRef = useRef<string>('/');
  const transfersRef = useRef<ActiveTransfer[]>([]);
  // 打开时的目标目录（渲染期同步，供挂载 / 切换标签时读取最新值）
  const initialPathRef = useRef<string | undefined>(initialPath);
  initialPathRef.current = initialPath;
  // 当前渲染帧的导航请求（供挂载 effect 读取，但不作为依赖）
  const navReqRef = useRef(navReq);
  navReqRef.current = navReq;
  // 稳定回调 ref：供 SftpFileList 的 memo 比较使用，避免每 100ms 进度事件导致文件列表重渲染
  const handlersRef = useRef<{
    enter: (e: SftpEntry) => void;
    download: (e: SftpEntry) => void;
    rename: (e: SftpEntry) => void;
    remove: (e: SftpEntry) => void;
    rowPointerDown: (e: SftpEntry, ev: React.PointerEvent) => void;
  }>({
    enter: () => {},
    download: () => {},
    rename: () => {},
    remove: () => {},
    rowPointerDown: () => {},
  });
  // 加载序号：只允许最新一次请求更新界面（防止旧请求覆盖新结果）
  const loadSeqRef = useRef(0);
  // 是否已发生过 cd 导航（避免挂载时 home 加载覆盖 cd 目标）
  const navLoadedRef = useRef(false);
  // 组件是否仍然存活：在卸载后置 false，供在途传输的进度回调 / finally 自查
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const keepRefs = (p: string, ts: ActiveTransfer[]) => {
    pathRef.current = p;
    transfersRef.current = ts;
  };

  // 加载目录；带序号防竞态：只允许最新一次请求更新界面
  const load = useCallback(
    async (p: string) => {
      const seq = ++loadSeqRef.current;
      setLoading(true);
      setError('');
      try {
        const list = await sftpList(tab.id, p);
        if (seq !== loadSeqRef.current) return; // 已被更新的请求取代
        setEntries(list);
        setPath(p);
        keepRefs(p, transfersRef.current);
        // 加载成功 → 上报（App 据此确认 cd 导航，提交 OLDPWD）
        onPathLoaded?.(tab.id, p);
      } catch (e) {
        if (seq !== loadSeqRef.current) return;
        setError(String(e));
      } finally {
        if (seq === loadSeqRef.current) setLoading(false);
      }
    },
    [tab.id, onPathLoaded],
  );

  // 切换会话标签后重置导航标记：新标签的 home 加载不应被旧标签的 cd 导航标记拦截
  // （SftpPanel 随 activeTab 复用不重挂载，navLoadedRef 若残留 true 会导致
  //   面板停留在旧标签的目录内容，而不是加载新标签的 home）
  useEffect(() => {
    navLoadedRef.current = false;
    // 清空上一台主机的目录视图：面板随 activeTab 复用不重挂载，
    // 不重置的话用户会先看到上一台服务器的目录，等新 load() 返回才跳走。
    setEntries([]);
    // 路径直接落位到新标签的已知终端目录，避免闪一下 "/" 再跳
    setPath(initialPathRef.current || '/');
    setError('');
  }, [tab.id]);

  // 打开面板 / 切换标签：定位到「终端当前目录」并重新拉取列表（相当于自动刷新），
  // 只有拿不到终端目录时才回退 home。
  // 此前无条件加载 home，面板每次重开都会把已经跟随到的目录拽回 /root；而
  // 提示符导航有「cwd 未变化就不重复导航」的去重，导致它再也回不到真实目录。
  useEffect(() => {
    let cancelled = false;
    // 挂载当帧的 cd 导航请求由下方独立 effect 处理，这里不重复加载
    const pendingNav = navReqRef.current;
    const tracked = pendingNav?.path ?? getCurrentCwd?.(tab.id) ?? initialPathRef.current;

    // home 仍然要拉一次：`~` / 相对路径解析、cd 同步都依赖它。
    // 但只用它做兜底，绝不用来覆盖已知的终端目录。
    void sftpHome(tab.id)
      .then((home) => {
        if (cancelled) return;
        onHomeReady(tab.id, home);
        if (!pendingNav && !tracked && !navLoadedRef.current) {
          void load(home);
        }
      })
      .catch((e) => {
        if (cancelled || pendingNav || tracked || navLoadedRef.current) return;
        setError(String(e));
      });

    if (tracked && !pendingNav) void load(tracked);
    return () => {
      cancelled = true;
    };
    // navReq 故意不进依赖：它被消费后变成 null 会再跑一次本 effect，
    // 用旧的 cwd 覆盖正在加载的 cd 目标（这正是面板乱跳的成因之一）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.id, load, onHomeReady]);

  // 终端 cd 同步导航（一次性请求，消费后通知 App 清除）
  // 导航失败时仅保留错误提示，不回退加载其它目录（避免污染 shell 目录跟踪）
  useEffect(() => {
    if (navReq) {
      navLoadedRef.current = true;
      void load(navReq.path);
      onNavConsumed();
    }
  }, [navReq, load, onNavConsumed]);

  // 窗口级文件拖拽（上传）
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;

    const overPanel = (x: number, y: number) => {
      const el = panelRef.current;
      if (!el) return false;
      if (!Number.isFinite(x) || !Number.isFinite(y)) return true; // 无位置信息时按面板内处理
      // Tauri 拖拽事件 position 为物理像素；同时兼容物理 / CSS 两种口径，
      // 避免高 DPI（125% / 150% 缩放）屏幕上命中区域偏移导致拖拽上传失效
      const r = el.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      return (
        (x >= r.left * dpr &&
          x <= r.right * dpr &&
          y >= r.top * dpr &&
          y <= r.bottom * dpr) ||
        (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom)
      );
    };

    getCurrentWindow()
      .onDragDropEvent((event) => {
        if (disposed) return;
        const payload = event.payload;
        if (payload.type === 'over') {
          setDragOver(overPanel(payload.position.x, payload.position.y));
        } else if (payload.type === 'leave') {
          setDragOver(false);
        } else if (payload.type === 'drop') {
          setDragOver(false);
          if (overPanel(payload.position.x, payload.position.y)) {
            void uploadPaths(payload.paths);
          }
        }
      })
      .then((u) => {
        if (disposed) u(); // 已卸载 → 立即清理
        else unlisten = u;  // 保持监听器活动
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.id]);

  // 右键菜单：点击菜单外部 / Esc / 滚动时关闭
  useEffect(() => {
    if (!ctxMenu) return;
    const onDown = (e: PointerEvent) => {
      const el = ctxMenuRef.current;
      if (el && e.target instanceof Node && el.contains(e.target)) return; // 菜单内部点击不关闭
      setCtxMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setCtxMenu(null);
    };
    const onScroll = () => setCtxMenu(null);
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    document.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('scroll', onScroll, true);
    };
  }, [ctxMenu]);

  const join = (name: string) => (path.endsWith('/') ? path + name : path + '/' + name);
  const parentOf = (p: string) => {
    const t = p.replace(/\/+$/, '');
    const idx = t.lastIndexOf('/');
    return idx <= 0 ? '/' : t.slice(0, idx);
  };

  const enter = (e: SftpEntry) => {
    if (e.isDir) void load(e.path);
  };

  const refresh = () => void load(path);

  // 手动跟随：立即定位到终端此刻所在目录（提示符无法解析时的兜底入口）
  const syncToCwd = () => {
    const p = getCurrentCwd?.(tab.id) ?? initialPathRef.current;
    if (!p) {
      setError('暂未获取到终端当前目录，请先在终端里执行一次命令');
      return;
    }
    void load(p);
  };

  const mkdir = () => {
    setPrompt({
      title: '新建文件夹',
      placeholder: '请输入新文件夹名称',
      defaultValue: '新建文件夹',
      onConfirm: (name) => {
        const n = name.trim();
        if (!n) return;
        void sftpMkdir(tab.id, join(n))
          .then(refresh)
          .catch((e) => setError(String(e)));
      },
    });
  };

  // ---------- 传输（上传/下载统一核心：失败保留进度条 + 错误提示 + 重试） ----------

  const setT = useCallback((updater: (ts: ActiveTransfer[]) => ActiveTransfer[]) => {
    setTransfers((ts) => {
      const next = updater(ts);
      transfersRef.current = next;
      return next;
    });
  }, []);

  // 正在传输的 key 集合：防止同一传输项被并发重复启动（如快速连点重试）
  const runningKeysRef = useRef<Set<string>>(new Set());

  // "已完成"提示的自动消失定时器：完成 5 秒后自动移除该传输项
  const dismissTimersRef = useRef<Map<string, number>>(new Map());
  useEffect(() => {
    const timers = dismissTimersRef.current;
    return () => {
      timers.forEach((t) => window.clearTimeout(t));
      timers.clear();
    };
  }, []);

  const runTransfer = useCallback(
    async (
      type: 'upload' | 'download',
      localPath: string, // upload=本地源 / download=本地目标
      remotePath: string, // upload=远程目标 / download=远程源
      name: string,
      key: string,
      resume = false,
    ) => {
      if (runningKeysRef.current.has(key)) return;
      runningKeysRef.current.add(key);
      // 首次启动时添加传输项；重试时重置为运行中（保留续传标记）
      setT((ts) =>
        ts.some((t) => t.key === key)
          ? ts.map((t) =>
              t.key === key
                ? {
                    ...t,
                    status: 'running',
                    error: undefined,
                    progress: { ...ZERO_PROGRESS },
                    resuming: resume,
                  }
                : t,
            )
          : [
              ...ts,
              {
                key,
                name,
                type,
                status: 'running',
                progress: { ...ZERO_PROGRESS },
                retry: { localPath, remotePath },
                resuming: resume,
              },
            ],
      );
      const onProgress = (p: TransferProgress) => {
        // 面板已卸载 / 标签已切换：继续写 state 无意义，
        // 并且 finally 里的 load() 会给一个已离开的会话发新的 sftpList。
        if (aliveRef.current === false) return;
        setT((ts) => ts.map((t) => (t.key === key ? { ...t, progress: p } : t)));
        // 同名冲突：加入队列逐个弹出处理（后端传输任务挂起等待回复）
        if (p.conflict) {
          const c = p.conflict;
          // 去重：后端在挂起期间仍会持续推送带 conflict 的进度帧，
          // 不去重会让同一个 requestId 在队列里堆叠、弹窗反复重开。
          setConflictQueue((q) =>
            q.some((i) => i.requestId === c.requestId)
              ? q
              : [...q, { requestId: c.requestId, name: c.name, path: c.path }],
          );
        }
      };
      let ok = false;
      try {
        if (type === 'upload') {
          await sftpUpload(tab.id, localPath, remotePath, onProgress, resume);
        } else {
          await sftpDownload(tab.id, remotePath, localPath, onProgress, resume);
        }
        ok = true;
      } catch (e) {
        // 失败：保留进度条并显示错误原因，供用户重试
        setT((ts) =>
          ts.map((t) =>
            t.key === key
              ? { ...t, status: 'failed', error: String(e), resuming: false }
              : t,
          ),
        );
      } finally {
        runningKeysRef.current.delete(key);
        if (ok && aliveRef.current !== false) {
          // 完成：显示"已完成"提示 5 秒后自动消失（失败项不自动消失，留着重试）
          setT((ts) =>
            ts.map((t) =>
              t.key === key ? { ...t, status: 'done', progress: { ...t.progress, percent: 100 } } : t,
            ),
          );
          if (type === 'upload') {
            // 上传完成：刷新目标目录（传输项由 5 秒定时器移除）
            const idx = remotePath.lastIndexOf('/');
            void load(idx > 0 ? remotePath.substring(0, idx) : '/');
          }
          const timer = window.setTimeout(() => {
            dismissTimersRef.current.delete(key);
            setT((ts) => ts.filter((t) => t.key !== key));
          }, 5000);
          dismissTimersRef.current.set(key, timer);
        }
      }
    },
    [tab.id, load, setT],
  );

  // 重试：复用原路径重新执行；带断点续传（后端自动从已传部分继续）
  const retryTransfer = useCallback(
    (key: string) => {
      const t = transfersRef.current.find((x) => x.key === key);
      if (!t || !t.retry || t.status === 'running') return;
      setT((ts) => ts.map((x) => (x.key === key ? { ...x, resuming: true } : x)));
      void runTransfer(t.type, t.retry.localPath, t.retry.remotePath, t.name, key, true);
    },
    [runTransfer, setT],
  );

  // 移除失败的传输项
  const dismissTransfer = useCallback(
    (key: string) => {
      setT((ts) => ts.filter((t) => t.key !== key));
    },
    [setT],
  );

  // 回复传输冲突处理方式（overwrite/skip/rename/overwrite_all/skip_all/cancel）
  const resolveConflict = (action: string) => {
    const head = conflictQueue[0];
    if (!head) return;
    // 注意：不要把 IPC 调用塞进 setState 的 updater 里。updater 必须是纯函数，
    // React 在 StrictMode 下会故意调用两次来做开发期校验 —— 那样后端会收到
    // 两条相同 requestId 的冲突回复，传输按第一个决定执行、第二个静默丢弃。
    setConflictQueue((q) => q.slice(1));
    void sftpResolveConflict(head.requestId, action).catch((e) => {
      setError(`处理冲突失败：${String(e)}`);
    });
  };

  const runUpload = useCallback(
    async (localPath: string, targetDir: string) => {
      const name = localPath.split(/[\\/]/).pop() || 'file';
      const remotePath = targetDir.endsWith('/')
        ? targetDir + name
        : targetDir + '/' + name;
      const key = `up-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      await runTransfer('upload', localPath, remotePath, name, key);
    },
    [runTransfer],
  );

  // 拖拽 / 对话框选择的上传入口
  const uploadPaths = useCallback(
    async (paths: string[]) => {
      if (paths.length === 0) return;
      const dir = pathRef.current;
      const concurrency = 3;
      for (let i = 0; i < paths.length; i += concurrency) {
        const batch = paths.slice(i, i + concurrency);
        await Promise.all(batch.map((p) => runUpload(p, dir)));
      }
    },
    [runUpload],
  );

  // 对话框插件的 open/save 会 reject（scope 错误、对话框已打开、权限不足等）。
  // 这些函数都是从 onClick 以 void 调起的，没有 await 也没有 catch，
  // 任何一次失败都会变成完全没有反馈的 unhandledrejection。
  const runDialog = async <T,>(fn: () => Promise<T>): Promise<T | null> => {
    try {
      return await fn();
    } catch (e) {
      setError(`文件对话框失败：${String(e)}`);
      return null;
    }
  };

  const uploadDialog = async () => {
    const picked = await runDialog(() =>
      open({ multiple: true, directory: false, title: '选择要上传的文件' }),
    );
    if (!picked) return;
    const files = Array.isArray(picked) ? picked : [picked];
    await uploadPaths(files);
  };

  const uploadDirDialog = async () => {
    const picked = await runDialog(() =>
      open({ multiple: true, directory: true, title: '选择要上传的文件夹' }),
    );
    if (!picked) return;
    const dirs = Array.isArray(picked) ? picked : [picked];
    await uploadPaths(dirs);
  };

  // ---------- 下载 ----------

  const runDownload = useCallback(
    async (entry: SftpEntry, dest: string) => {
      const key = `down-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      await runTransfer('download', dest, entry.path, entry.name, key);
    },
    [runTransfer],
  );

  const download = async (entry: SftpEntry) => {
    if (entry.isDir) {
      // 目录：选择本地保存位置，整目录递归下载
      // recursive: true 必须显式传入 —— dialog 插件在选中目录时会执行
      // allow_directory(path, recursive) 把该目录写入 fs scope；缺省 false 时
      // 仅授权目录本身而不含子项，递归写入会被 scope 拦下。
      const picked = await runDialog(() =>
        open({
          directory: true,
          recursive: true,
          title: `选择保存位置（将下载整个文件夹「${entry.name}」）`,
        }),
      );
      if (!picked) return;
      const dir = Array.isArray(picked) ? picked[0] : picked;
      if (!dir) return;
      const target =
        dir.endsWith('/') || dir.endsWith('\\')
          ? dir + entry.name
          : dir + '/' + entry.name;
      await runDownload(entry, target);
      return;
    }
    const dest = await runDialog(() =>
      save({ defaultPath: entry.name, title: '保存到本地' }),
    );
    if (!dest) return;
    await runDownload(entry, dest);
  };

  // ---------- 拖拽下载（拖出面板） ----------
  //
  // 流程：手势激活（位移 >8px）→ 先经 SFTP 下载到本地下载目录；
  // 下载完成时若鼠标仍按住 → 调用 Rust `drag_out_files` 启动系统原生拖拽
  // （DoDragDrop），此后拖到桌面/资源管理器任意目录松手即复制到那里。
  // 若中途松手，下载照常完成（等同"下载到默认目录"），不启动原生拖拽。

  // 修改默认下载目录（drop 提示行上的目录名可点击）
  const chooseDlDir = async () => {
    const picked = await runDialog(() =>
      open({
        directory: true,
        recursive: true,
        title: '选择默认下载目录（拖拽下载将保存到此目录）',
      }),
    );
    if (!picked) return;
    const dir = (Array.isArray(picked) ? picked[0] : picked) || '';
    if (!dir) return;
    try {
      localStorage.setItem(DLDIR_KEY, dir);
    } catch {
      /* 存储失败时仅本次会话生效 */
    }
    setDlDir(dir);
  };

  // 拖拽目标目录：用户设置的默认目录，未设置则回退系统"下载"目录
  const resolveDragTargetDir = async (): Promise<string> => {
    if (dlDir) return dlDir;
    try {
      return (await getLocalDownloadDir()) || '';
    } catch {
      return '';
    }
  };

  // 手势激活时启动：下载到目标目录，完成后视鼠标状态接管为原生拖拽
  const startGestureDownload = async (
    st: {
      entry: SftpEntry;
      held: boolean;
      cleanup?: () => void;
    },
  ) => {
    const dir = await resolveDragTargetDir();
    if (!dir) return;
    const target =
      dir.endsWith('/') || dir.endsWith('\\')
        ? dir + st.entry.name
        : dir + '/' + st.entry.name;
    try {
      await runDownload(st.entry, target);
    } catch {
      return; // runDownload 已把失败状态写进传输列表
    }
    // 下载完成且鼠标仍未松开 → 启动系统原生拖拽：拖到桌面/任意文件夹松手即复制
    if (st.held) {
      setRowDrag(null); // 原生拖拽期间由系统接管，收掉幽灵提示
      try {
        await invoke('drag_out_files', { paths: [target] });
      } catch {
        // 取消或失败静默：文件本身已在下载目录，不算错误
      } finally {
        // 原生拖拽吞掉了 pointerup，旧手势的监听器必须在这里清掉
        st.cleanup?.();
      }
    }
  };

  // 光标是否在 SFTP 面板内（决定幽灵提示是否显示"拖到桌面/文件夹"）
  const inPanel = (x: number, y: number): boolean => {
    const el = panelRef.current;
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  };

  // 行上按下鼠标：位移超过阈值即进入拖拽手势（双击进入目录 / 右键菜单不受影响）。
  // setPointerCapture 保证拖到窗口外仍能收到 move / up 事件。
  const beginRowPointerDown = useCallback(
    (entry: SftpEntry, ev: React.PointerEvent) => {
      if (ev.button !== 0) return;
      if ((ev.target as HTMLElement).closest('button, select, input, textarea')) return;
      const st: {
        entry: SftpEntry;
        startX: number;
        startY: number;
        active: boolean;
        held: boolean;
        cleanup?: () => void;
      } = {
        entry,
        startX: ev.clientX,
        startY: ev.clientY,
        active: false,
        held: true,
      };
      rowDragRef.current = st;
      // 注意：这里不能 setPointerCapture —— 它会让 Chromium 在 Win32 层
      // 抢占鼠标捕获，与后续 OLE 原生拖拽（DoDragDrop）的捕获互相打架，
      // 导致原生拖拽几步之后失联。不捕获时窗口内的 move 依旧可用，
      // 原生拖拽一旦启动，鼠标事件由 OLE 接管。
      const cleanup = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', finish);
        window.removeEventListener('pointercancel', finish);
        st.held = false;
        if (rowDragRef.current === st) rowDragRef.current = null;
        setRowDrag(null);
      };
      // 原生拖拽结束后 pointerup 不会回到页面（被 OLE 吞掉），
      // 必须在这里主动清理，否则残留的 move 监听会污染下一次手势
      st.cleanup = cleanup;
      const move = (e: PointerEvent) => {
        const cur = rowDragRef.current;
        if (!cur) return;
        if (!cur.active) {
          if (Math.hypot(e.clientX - st.startX, e.clientY - st.startY) < 8) return;
          cur.active = true;
          void startGestureDownload(cur);
        }
        setRowDrag({
          entry: cur.entry,
          x: e.clientX,
          y: e.clientY,
          outside: !inPanel(e.clientX, e.clientY),
        });
      };
      const finish = () => {
        cleanup();
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', finish);
      window.addEventListener('pointercancel', finish);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dlDir, runDownload],
  );

  const rename = (entry: SftpEntry) => {
    setPrompt({
      title: '重命名',
      label: entry.name,
      placeholder: '请输入新名称',
      defaultValue: entry.name,
      selectAll: true,
      onConfirm: (name) => {
        const n = name.trim();
        if (!n || n === entry.name) return;
        const parentDir = entry.path.substring(0, entry.path.lastIndexOf('/'));
        const newPath = (parentDir || '/') + '/' + n;
        void sftpRename(tab.id, entry.path, newPath)
          .then(refresh)
          .catch((e) => setError(String(e)));
      },
    });
  };

  const remove = async (entry: SftpEntry) => {
    let msg: string;
    let recursive: boolean;
    if (entry.isDir) {
      // 先检查文件夹是否为空，非空时给出递归删除警示确认
      let count = -1;
      let readFailed = false;
      try {
        count = (await sftpList(tab.id, entry.path)).length;
      } catch (e) {
        // 读不到目录时不能默默按"可能非空"推进：这是破坏性操作，
        // 必须在提示里如实说明状态未确认。
        readFailed = true;
        setError(`无法读取目录「${entry.name}」：${String(e)}`);
      }
      msg =
        count === 0
          ? `确定删除空文件夹「${entry.name}」吗？此操作不可撤销。`
          : readFailed
            ? `文件夹「${entry.name}」无法读取（权限不足或已被移除），将按递归删除整个目录处理，此操作不可撤销。确定删除吗？`
            : `文件夹「${entry.name}」，其中包含 ${count} 个项目，将递归删除整个文件夹及其全部内容，此操作不可撤销。确定删除吗？`;
      recursive = true;
    } else {
      msg = `确定删除文件「${entry.name}」吗？此操作不可撤销。`;
      recursive = false;
    }
    setConfirm({
      title: '删除',
      message: msg,
      confirmText: '删除',
      onConfirm: () => {
        void sftpRemove(tab.id, entry.path, recursive)
          .then(refresh)
          .catch((e) => setError(String(e)));
      },
    });
  };

  // ---------- 路径编辑 ----------

  const commitPath = () => {
    setEditingPath(false);
    const p = pathInput.trim();
    if (p && p !== path) void load(p);
  };

  // 每渲染更新最新回调引用，供稳定包装器使用
  handlersRef.current = {
    enter,
    download,
    rename,
    remove,
    rowPointerDown: beginRowPointerDown,
  };
  // 稳定回调包装器：引用不变，内部委托给 handlersRef.current，
  // 使 SftpFileList 的 memo 能在 entries 不变时跳过重渲染
  const stableEnter = useCallback((e: SftpEntry) => handlersRef.current.enter(e), []);
  const stableDownload = useCallback((e: SftpEntry) => handlersRef.current.download(e), []);
  const stableRename = useCallback((e: SftpEntry) => handlersRef.current.rename(e), []);
  const stableRemove = useCallback((e: SftpEntry) => handlersRef.current.remove(e), []);
  const stableRowPointerDown = useCallback(
    (e: SftpEntry, ev: React.PointerEvent) =>
      handlersRef.current.rowPointerDown(e, ev),
    [],
  );
  const stableCtxMenu = useCallback(
    (ev: React.MouseEvent, entry: SftpEntry) => {
      ev.preventDefault();
      ev.stopPropagation();
      setCtxMenu({ x: ev.clientX, y: ev.clientY, entry });
    },
    [],
  );

  const activeCount = transfers.length;
  // 当前待处理的冲突（队列头部）
  const pc = conflictQueue[0];

  return (
    <div
      className={`sftp-panel ${dragOver ? 'drop-target' : ''}`}
      ref={panelRef}
      onContextMenu={(e) => {
        e.preventDefault();
        // 右键发生在已打开的菜单内部时不覆盖（避免文件菜单被空白菜单替换）
        if (ctxMenuRef.current?.contains(e.target as Node)) return;
        // 右键空白处 → 上下文菜单（刷新 / 新建文件夹 / 上传）
        setCtxMenu({ x: e.clientX, y: e.clientY, entry: null });
      }}
    >
      <div className="sftp-header">
        <span className="sftp-title">SFTP · {tab.host}</span>
        <button className="icon-btn" title="关闭面板" onClick={onClose}>
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>

      <div className="sftp-pathbar">
        <button className="icon-btn" title="上一级" disabled={path === '/'} onClick={() => void load(parentOf(path))}>
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M19 12H5M11 18l-6-6 6-6" />
          </svg>
        </button>
        {editingPath ? (
          <input
            className="sftp-path-input"
            autoFocus
            value={pathInput}
            onChange={(e) => setPathInput(e.target.value)}
            onBlur={commitPath}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitPath();
              if (e.key === 'Escape') setEditingPath(false);
            }}
            spellCheck={false}
          />
        ) : (
          <div
            className="sftp-path"
            title="点击编辑路径（支持输入任意远程路径）"
            onClick={() => {
              setPathInput(path);
              setEditingPath(true);
            }}
          >
            {path}
          </div>
        )}
        <button className="icon-btn" title="定位到终端当前目录" onClick={syncToCwd}>
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="7" />
            <circle cx="12" cy="12" r="2.2" />
            <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
          </svg>
        </button>
        <button className="icon-btn" title="刷新" onClick={refresh}>
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 12a9 9 0 1 1-2.6-6.4M21 3v6h-6" />
          </svg>
        </button>
      </div>

      <div className="sftp-tools">
        <button className="sftp-tool primary" onClick={() => void uploadDialog()}>
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 16V4M7 9l5-5 5 5" />
            <path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
          </svg>
          上传文件
        </button>
        <button className="sftp-tool" onClick={() => void uploadDirDialog()} title="整目录递归上传">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
            <path d="M12 11v5M9.5 13.5h5" />
          </svg>
          上传文件夹
        </button>
      </div>

      <div className="sftp-drop-hint">
        拖出面板 = 下载 · 按住不松手可直接拖到桌面/任意文件夹 · 文件拖入上传
        <span
          className="sftp-dl-dir"
          title={dlDir || '未设置：使用系统下载目录'}
          onClick={() => void chooseDlDir()}
        >
          {dlDir ? ` → ${dlDir}` : '（下载目录：系统下载）'}
        </span>
      </div>

      <SftpFileList
        entries={entries}
        loading={loading}
        onEnter={stableEnter}
        onDownload={stableDownload}
        onRename={stableRename}
        onRemove={stableRemove}
        onContextMenu={stableCtxMenu}
        onRowPointerDown={stableRowPointerDown}
      />

      {/* 传输进度（失败时保留，显示错误并可重试/移除；下载完成后保留，可打开所在文件夹） */}
      {activeCount > 0 && (
        <div className="sftp-transfers">
          {transfers.map((t) => (
            <div
              className={`transfer-item ${t.status === 'failed' ? 'failed' : t.status === 'done' ? 'done' : ''}`}
              key={t.key}
            >
              <div className="transfer-row">
                <span className="transfer-name" title={t.name}>
                  {t.type === 'upload' ? '↑' : '↓'} {t.name}
                </span>
                <span className="transfer-pct">
                  {t.status === 'failed'
                    ? '传输失败'
                    : t.status === 'done'
                      ? '已完成'
                      : t.progress.total > 0
                        ? `${formatSize(t.progress.transferred)} / ${formatSize(t.progress.total)}`
                        : '准备中…'}
                  {t.status === 'failed' || t.status === 'done'
                    ? ''
                    : ` ${Math.round(t.progress.percent)}%`}
                </span>
                {(t.status === 'failed' || t.status === 'done') && (
                  <span className="transfer-actions">
                    {t.status === 'failed' && (
                      <button className="mini-btn" title="重试" onClick={() => retryTransfer(t.key)}>
                        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M21 12a9 9 0 1 1-2.6-6.4M21 3v6h-6" />
                        </svg>
                      </button>
                    )}
                    {t.status === 'done' && t.type === 'download' && (
                      <button
                        className="mini-btn"
                        title="打开所在文件夹"
                        onClick={() => {
                          const lp = t.retry?.localPath;
                          if (lp) void revealItemInDir(lp).catch(() => {});
                        }}
                      >
                        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M4 20h16M6 4h8l2 2h2a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z" />
                        </svg>
                      </button>
                    )}
                    <button className="mini-btn" title="移除" onClick={() => dismissTransfer(t.key)}>
                      <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                        <path d="M6 6l12 12M18 6L6 18" />
                      </svg>
                    </button>
                  </span>
                )}
              </div>
              {t.status === 'failed' && t.error && (
                <div className="transfer-err" title={t.error}>
                  {t.error}
                </div>
              )}
              {t.progress.file && (
                <div className="transfer-sub" title={t.progress.file}>
                  {t.progress.file}
                  {t.resuming && ' · 断点续传'}
                  {t.progress.totalFiles > 1 &&
                    ` · ${Math.min(t.progress.files + 1, t.progress.totalFiles)}/${t.progress.totalFiles} 个文件`}
                  {t.progress.skipped > 0 && ` · 已跳过 ${t.progress.skipped}`}
                </div>
              )}
              <div className="transfer-bar">
                <div
                  className={`transfer-bar-fill ${t.status === 'failed' ? 'fail' : t.type === 'upload' ? 'up' : 'down'}`}
                  style={{ width: `${Math.min(100, t.progress.percent)}%` }}
                />
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 拖拽下载幽灵提示：portal 渲染到 body（面板有 backdrop-filter，
          fixed 定位子元素会被其裁剪），拖出面板后依然可见 */}
      {rowDrag &&
        createPortal(
          <>
            {rowDrag.outside && (
              <div
                className="sftp-drag-hint"
                style={{ left: rowDrag.x + 14, top: rowDrag.y + 20 }}
              >
                {rowDrag.entry.isDir ? '整个文件夹' : '文件'}下载中…
                完成前保持按住，完成后可拖到桌面/任意文件夹松手
              </div>
            )}
            <div
              className="sftp-drag-ghost"
              style={{ left: rowDrag.x + 10, top: rowDrag.y + 8 }}
            >
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 4v12M7 11l5 5 5-5" />
                <path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
              </svg>
              {rowDrag.entry.name}
            </div>
          </>,
          document.body,
        )}

      {/* 拖拽上传叠层 */}
      {dragOver && (
        <div className="sftp-drop-overlay">
          <svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 16V4M7 9l5-5 5 5" />
            <path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
          </svg>
          <p>松开以上传到 {path}</p>
        </div>
      )}

      {error && (
        <div className="sftp-statusline error">{error}</div>
      )}

      {/* 右键上下文菜单 */}
      {ctxMenu && (
        <div
          className="ctx-menu"
          ref={ctxMenuRef}
          style={{
            left: Math.max(0, Math.min(ctxMenu.x, window.innerWidth - 180)),
            top: Math.max(0, Math.min(ctxMenu.y, window.innerHeight - 230)),
          }}
        >
          {ctxMenu.entry && (
            <div className="ctx-menu-title" title={ctxMenu.entry.path}>
              {ctxMenu.entry.name}
            </div>
          )}
          {ctxMenu.entry ? (
            <>
              {ctxMenu.entry.isDir && (
                <div
                  className="ctx-menu-item"
                  onClick={() => {
                    const en = ctxMenu.entry;
                    setCtxMenu(null);
                    if (en) enter(en);
                  }}
                >
                  <CtxIcon path="open" /> 打开
                </div>
              )}
              <div
                className="ctx-menu-item"
                onClick={() => {
                  const en = ctxMenu.entry;
                  setCtxMenu(null);
                  if (en) void download(en);
                }}
              >
                <CtxIcon path="download" />
                {ctxMenu.entry.isDir ? '下载文件夹' : '下载'}
              </div>
              <div
                className="ctx-menu-item"
                onClick={() => {
                  const en = ctxMenu.entry;
                  setCtxMenu(null);
                  if (en) void rename(en);
                }}
              >
                <CtxIcon path="rename" /> 重命名
              </div>
              <div
                className="ctx-menu-item danger"
                onClick={() => {
                  const en = ctxMenu.entry;
                  setCtxMenu(null);
                  if (en) void remove(en);
                }}
              >
                <CtxIcon path="delete" /> 删除
              </div>
            </>
          ) : (
            <>
              <div
                className="ctx-menu-item"
                onClick={() => {
                  setCtxMenu(null);
                  refresh();
                }}
              >
                <CtxIcon path="refresh" /> 刷新
              </div>
              <div
                className="ctx-menu-item"
                onClick={() => {
                  setCtxMenu(null);
                  void mkdir();
                }}
              >
                <CtxIcon path="folder" /> 新建文件夹
              </div>
              <div
                className="ctx-menu-item"
                onClick={() => {
                  setCtxMenu(null);
                  void uploadDialog();
                }}
              >
                <CtxIcon path="upload" /> 上传文件
              </div>
            </>
          )}
        </div>
      )}

      {/* 应用内确认 / 输入弹窗（替换原生 window.confirm / window.prompt） */}
      {prompt && (
        <Modal
          title={prompt.title}
          input={{
            label: prompt.label,
            defaultValue: prompt.defaultValue,
            placeholder: prompt.placeholder,
            selectAll: prompt.selectAll,
          }}
          onClose={() => setPrompt(null)}
          onConfirm={(v) => {
            const p = prompt;
            setPrompt(null);
            p.onConfirm(v);
          }}
        />
      )}
      {confirm && (
        <Modal
          title={confirm.title}
          message={confirm.message}
          confirmText={confirm.confirmText ?? '确定'}
          danger
          onClose={() => setConfirm(null)}
          onConfirm={() => {
            const c = confirm;
            setConfirm(null);
            c.onConfirm();
          }}
        />
      )}

      {/* 同名文件冲突处理弹窗（逐个弹出；传输任务挂起等待选择） */}
      {pc && (
        <div className="modal-backdrop" style={{ zIndex: 300 }}>
          <div className="modal conflict-modal">
            <div className="modal-header">
              <h2>
                同名文件冲突
                {conflictQueue.length > 1
                  ? `（还有 ${conflictQueue.length - 1} 个待处理）`
                  : ''}
              </h2>
            </div>
            <div className="modal-body">
              <p className="conflict-text">
                目标已存在「<span className="conflict-name">{pc.name}</span>」
              </p>
              <p className="conflict-path" title={pc.path}>
                {pc.path}
              </p>
              <div className="conflict-actions">
                <button className="btn primary" onClick={() => resolveConflict('overwrite')}>
                  覆盖
                </button>
                <button className="btn" onClick={() => resolveConflict('skip')}>
                  跳过
                </button>
                <button className="btn" onClick={() => resolveConflict('rename')}>
                  重命名
                </button>
                <button className="btn" onClick={() => resolveConflict('overwrite_all')}>
                  全部覆盖
                </button>
                <button className="btn" onClick={() => resolveConflict('skip_all')}>
                  全部跳过
                </button>
                <button className="btn" onClick={() => resolveConflict('cancel')}>
                  取消传输
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
