import { useEffect } from 'react';
import type { SessionSummary } from '../types';

interface Props {
  sessions: SessionSummary[];
  onPick: (id: string) => void;
  onClose: () => void;
  /** 前置检查提示（如“已存在集群监控标签”“会话已断开”），为空不展示 */
  message?: string;
}

/** 集群监控：选择目标会话的模态框（列出已连接的 SSH 会话） */
export default function SessionPicker({ sessions, onPick, onClose, message }: Props) {
  // Esc 关闭
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
          <span>选择集群监控目标会话</span>
          <button className="icon-btn" onClick={onClose} title="关闭">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>
        <div className="modal-body">
          {message && <div className="picker-warning">{message}</div>}
          {sessions.length === 0 ? (
            <div className="picker-empty">
              <p>没有已连接的 SSH 会话</p>
              <p className="picker-empty-sub">请先连接一台服务器，再打开集群监控</p>
            </div>
          ) : (
            <div className="picker-list">
              {sessions.map((s) => (
                <div
                  key={s.id}
                  className="picker-item"
                  onClick={() => onPick(s.id)}
                  title={`${s.username}@${s.host}:${s.port}`}
                >
                  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="4" width="18" height="7" rx="2" />
                    <rect x="3" y="13" width="18" height="7" rx="2" />
                    <path d="M7 7.5h.01M7 16.5h.01" strokeLinecap="round" />
                  </svg>
                  <span className="picker-item-name">
                    {s.username}@{s.host}
                    <span className="picker-item-port">:{s.port}</span>
                  </span>
                  <span className="picker-item-state">已连接</span>
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
