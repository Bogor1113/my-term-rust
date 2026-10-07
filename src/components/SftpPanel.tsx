import { memo, useCallback, useEffect, useRef, useState } from 'react';
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
}: {
  entries: SftpEntry[];
  loading: boolean;
  onEnter: (e: SftpEntry) => void;
  onDownload: (e: SftpEntry) => void;
  onRename: (e: SftpEntry) => void;
  onRemove: (e: SftpEntry) => void;
  onContextMenu: (e: React.MouseEvent, entry: SftpEntry) => void;
}) {
  return (
    <div className="sftp-list">
      <div className="sftp-list-head">
        <span>名称</span>
        <span>大小</span>
        <span>权限</span>
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
            <span className="sftp-perms">{e.perms}</span>
            <span className="sftp-actions">
              {!e.isDir && (
                <button className="mini-btn" title="下载" onClick={() => onDownload(e)}>
                  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 4v12M7 11l5 5 5-5" />
                    <path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
                  </svg>
                </button>
              )}
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
}: Props) {
  const [path, setPath] = useState('/');
  const [entries, setEntries] = useState<SftpEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [editingPath, setEditingPath] = useState(false);
  const [pathInput, setPathInput] = useState('');
  const [transfers, setTransfers] = useState<ActiveTransfer[]>([]);
  const [dragOver, setDragOver] = useState(false);
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
  // 稳定回调 ref：供 SftpFileList 的 memo 比较使用，避免每 100ms 进度事件导致文件列表重渲染
  const handlersRef = useRef<{
    enter: (e: SftpEntry) => void;
    download: (e: SftpEntry) => void;
    rename: (e: SftpEntry) => void;
    remove: (e: SftpEntry) => void;
  }>({
    enter: () => {},
    download: () => {},
    rename: () => {},
    remove: () => {},
  });
  // 加载序号：只允许最新一次请求更新界面（防止旧请求覆盖新结果）
  const loadSeqRef = useRef(0);
  // 是否已发生过 cd 导航（避免挂载时 home 加载覆盖 cd 目标）
  const navLoadedRef = useRef(false);

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
  }, [tab.id]);

  // 初次挂载：获取 home 并上报；若无待处理的 cd 导航则进入 home
  useEffect(() => {
    let cancelled = false;
    void sftpHome(tab.id)
      .then((home) => {
        if (cancelled) return;
        onHomeReady(tab.id, home);
        // 已发生 cd 导航时不加载 home，避免覆盖目标目录
        if (!navLoadedRef.current) {
          void load(home);
        }
      })
      .catch((e) => {
        if (!cancelled && !navLoadedRef.current) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
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
        setT((ts) => ts.map((t) => (t.key === key ? { ...t, progress: p } : t)));
        // 同名冲突：加入队列逐个弹出处理（后端传输任务挂起等待回复）
        if (p.conflict) {
          const c = p.conflict;
          setConflictQueue((q) => [
            ...q,
            { requestId: c.requestId, name: c.name, path: c.path },
          ]);
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
        if (ok) {
          if (type === 'download') {
            // 下载完成：保留传输项显示"已完成"，可打开所在文件夹 / 移除
            setT((ts) =>
              ts.map((t) =>
                t.key === key
                  ? { ...t, status: 'done', progress: { ...t.progress, percent: 100 } }
                  : t,
              ),
            );
          } else {
            // 上传成功：移除传输项并刷新目标目录
            setT((ts) => ts.filter((t) => t.key !== key));
            const idx = remotePath.lastIndexOf('/');
            void load(idx > 0 ? remotePath.substring(0, idx) : '/');
          }
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
    setConflictQueue((q) => {
      const [head, ...rest] = q;
      if (head) {
        void sftpResolveConflict(head.requestId, action).catch(() => {});
      }
      return rest;
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

  const uploadDialog = async () => {
    const picked = await open({ multiple: true, directory: false, title: '选择要上传的文件' });
    if (!picked) return;
    const files = Array.isArray(picked) ? picked : [picked];
    await uploadPaths(files);
  };

  const uploadDirDialog = async () => {
    const picked = await open({ multiple: true, directory: true, title: '选择要上传的文件夹' });
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
      const picked = await open({
        directory: true,
        title: `选择保存位置（将下载整个文件夹「${entry.name}」）`,
      });
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
    const dest = await save({ defaultPath: entry.name, title: '保存到本地' });
    if (!dest) return;
    await runDownload(entry, dest);
  };

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
      try {
        count = (await sftpList(tab.id, entry.path)).length;
      } catch {
        /* 忽略：无法读取时按可能非空处理 */
      }
      msg =
        count === 0
          ? `确定删除空文件夹「${entry.name}」吗？此操作不可撤销。`
          : `文件夹「${entry.name}」${count > 0 ? `，其中包含 ${count} 个项目` : '（可能包含内容）'}，将递归删除整个文件夹及其全部内容，此操作不可撤销。确定删除吗？`;
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
  };
  // 稳定回调包装器：引用不变，内部委托给 handlersRef.current，
  // 使 SftpFileList 的 memo 能在 entries 不变时跳过重渲染
  const stableEnter = useCallback((e: SftpEntry) => handlersRef.current.enter(e), []);
  const stableDownload = useCallback((e: SftpEntry) => handlersRef.current.download(e), []);
  const stableRename = useCallback((e: SftpEntry) => handlersRef.current.rename(e), []);
  const stableRemove = useCallback((e: SftpEntry) => handlersRef.current.remove(e), []);
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
        <button className="icon-btn" title="刷新" onClick={refresh}>
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 12a9 9 0 1 1-2.6-6.4M21 3v6h-6" />
          </svg>
        </button>
      </div>

      <div className="sftp-tools">
        <button className="sftp-tool" onClick={mkdir}>
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
            <path d="M12 11v5M9.5 13.5h5" />
          </svg>
          新建文件夹
        </button>
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

      <div className="sftp-drop-hint">将本地文件/文件夹拖入面板即可上传</div>

      <SftpFileList
        entries={entries}
        loading={loading}
        onEnter={stableEnter}
        onDownload={stableDownload}
        onRename={stableRename}
        onRemove={stableRemove}
        onContextMenu={stableCtxMenu}
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
