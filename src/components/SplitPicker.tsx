import { useEffect } from 'react';
import type { TabInfo } from '../types';

interface Props {
  /** 可供选择的标签（SSH 终端 + 集群监控，已排除当前激活标签） */
  tabs: TabInfo[];
  onPick: (id: string) => void;
  onClose: () => void;
}

/** 分屏：选择右侧面板显示的第二个标签（SSH 或集群监控） */
export default function SplitPicker({ tabs, onPick, onClose }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal session-picker">
        <div className="modal-header">
          <span>选择右侧分屏标签</span>
          <button className="icon-btn" onClick={onClose} title="关闭">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>
        <div className="modal-body">
          {tabs.length === 0 ? (
            <div className="picker-empty">
              <p>没有可用的其它标签</p>
              <p className="picker-empty-sub">请先再打开一个 SSH 会话或集群监控，即可左右分屏</p>
            </div>
          ) : (
            <div className="picker-list">
              {tabs.map((t) => (
                <div
                  key={t.id}
                  className="picker-item"
                  onClick={() => onPick(t.id)}
                  title={t.kind === 'cluster' ? `集群监控 · ${t.username}@${t.host}` : `${t.username}@${t.host}:${t.port}`}
                >
                  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="4" width="18" height="7" rx="2" />
                    <rect x="3" y="13" width="18" height="7" rx="2" />
                    <path d="M7 7.5h.01M7 16.5h.01" strokeLinecap="round" />
                  </svg>
                  <span className="picker-item-name">
                    {t.kind === 'cluster' ? `集群监控 · ${t.username}@${t.host}` : `${t.username}@${t.host}`}
                    {t.kind !== 'cluster' && (
                      <span className="picker-item-port">:{t.port}</span>
                    )}
                  </span>
                  <span className="picker-item-state">{t.kind === 'cluster' ? 'CLUSTER' : 'SSH'}</span>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button className="btn ghost" onClick={onClose}>
            取消
          </button>
        </div>
      </div>
    </div>
  );
}
