import { useEffect, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';

/**
 * 自绘标题栏：原生装饰已关闭（tauri.conf.json decorations:false），
 * 顶部这条玻璃质感条替代系统标题栏，拖拽区 + 最小化/最大化/关闭。
 * 双击拖拽区由 Tauri 的 data-tauri-drag-region 自动处理为最大化/还原。
 */
export default function TitleBar() {
  const appWindow = getCurrentWindow();
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    const sync = () => {
      appWindow.isMaximized().then(setMaximized).catch(() => {});
    };
    sync();
    appWindow
      .onResized(sync)
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => {});
    return () => {
      unlisten?.();
    };
  }, [appWindow]);

  return (
    <div className="titlebar">
      <div className="titlebar-drag" data-tauri-drag-region>
        <img className="titlebar-logo" src="/myterm.svg" alt="" draggable={false} />
        <span className="titlebar-title" data-tauri-drag-region>
          MyTerm
        </span>
        <span className="titlebar-sub" data-tauri-drag-region>
          波哥自研
        </span>
      </div>

      <div className="titlebar-controls">
        <button
          className="titlebar-btn"
          title="最小化"
          onClick={() => appWindow.minimize()}
        >
          <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
            <path d="M2 6h8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
          </svg>
        </button>

        <button
          className="titlebar-btn"
          title={maximized ? '向下还原' : '最大化'}
          onClick={() => appWindow.toggleMaximize()}
        >
          {maximized ? (
            <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
              <rect x="2.2" y="3.6" width="6.2" height="6.2" rx="1" fill="none" stroke="currentColor" strokeWidth="1.1" />
              <path d="M4.2 3.6V2.6a1 1 0 0 1 1-1h4.2a1 1 0 0 1 1 1V6.8a1 1 0 0 1-1 1h-1" fill="none" stroke="currentColor" strokeWidth="1.1" />
            </svg>
          ) : (
            <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
              <rect x="2.4" y="2.4" width="7.2" height="7.2" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.1" />
            </svg>
          )}
        </button>

        <button
          className="titlebar-btn close"
          title="关闭"
          onClick={() => appWindow.close()}
        >
          <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
            <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
          </svg>
        </button>
      </div>
    </div>
  );
}
