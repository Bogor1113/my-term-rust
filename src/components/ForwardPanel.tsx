import { useCallback, useEffect, useState } from 'react';
import type { ForwardInfo, SessionSummary } from '../types';
import { forwardAdd, forwardList, forwardRemove } from '../api';

interface Props {
  sessions: SessionSummary[];
  onClose: () => void;
}

export default function ForwardPanel({ sessions, onClose }: Props) {
  const [forwards, setForwards] = useState<ForwardInfo[]>([]);
  const [sessionId, setSessionId] = useState('');
  const [localPort, setLocalPort] = useState('0');
  const [remoteHost, setRemoteHost] = useState('');
  const [remotePort, setRemotePort] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');

  const refresh = useCallback(() => {
    forwardList()
      .then(setForwards)
      .catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    // Esc 关闭面板。焦点在终端或输入框内时按 Esc 是正常操作，不关闭。
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
    return () => window.removeEventListener('keydown', onKey);
  }, [refresh, onClose]);

  // 默认选中第一个已连接会话
  useEffect(() => {
    if (!sessionId && sessions.length > 0) setSessionId(sessions[0].id);
  }, [sessions, sessionId]);

  const addForward = async () => {
    setError('');
    setOk('');
    if (!sessionId) {
      setError('请选择一个已连接的 SSH 会话');
      return;
    }
    const rp = Number(remotePort);
    if (!remoteHost.trim() || !Number.isInteger(rp) || rp <= 0 || rp > 65535) {
      setError('请填写正确的目标主机和端口（1-65535）');
      return;
    }
    const lp = localPort.trim() === '' ? 0 : Number(localPort);
    if (!Number.isInteger(lp) || lp < 0 || lp > 65535) {
      setError('本地端口必须是 0-65535 的整数（0 表示自动分配）');
      return;
    }
    setBusy(true);
    try {
      const info = await forwardAdd(sessionId, lp, remoteHost.trim(), rp);
      setOk(`已添加：127.0.0.1:${info.localPort} → ${info.remoteHost}:${info.remotePort}`);
      setLocalPort('0');
      setRemoteHost('');
      setRemotePort('');
      refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const removeForward = async (f: ForwardInfo) => {
    setError('');
    setOk('');
    try {
      await forwardRemove(f.sessionId, f.localPort);
      refresh();
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div className="sftp-panel snippet-panel">
      <div className="sftp-header">
        <span className="sftp-title">端口转发</span>
        <div className="sftp-header-actions">
          <button className="icon-btn" title="刷新" onClick={refresh}>
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6" />
            </svg>
          </button>
          <button className="icon-btn" title="关闭" onClick={onClose}>
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>
      </div>

      <div className="snippet-add">
        <select
          className="snippet-input"
          value={sessionId}
          onChange={(e) => setSessionId(e.target.value)}
        >
          {sessions.length === 0 && <option value="">暂无已连接会话</option>}
          {sessions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.username}@{s.host}:{s.port}
            </option>
          ))}
        </select>
        <div className="fw-row">
          <input
            className="snippet-input fw-local"
            placeholder="本地端口(0=自动)"
            value={localPort}
            onChange={(e) => setLocalPort(e.target.value)}
          />
          <span className="fw-arrow">→</span>
          <input
            className="snippet-input fw-remote"
            placeholder="目标主机"
            value={remoteHost}
            onChange={(e) => setRemoteHost(e.target.value)}
          />
          <input
            className="snippet-input fw-port"
            placeholder="端口"
            value={remotePort}
            onChange={(e) => setRemotePort(e.target.value)}
          />
        </div>
        <div className="snippet-add-actions">
          <button className="btn primary" onClick={addForward} disabled={busy}>
            {busy ? '添加中…' : '添加转发'}
          </button>
        </div>
        {error && <div className="form-error">{error}</div>}
        {ok && <div className="fw-ok">{ok}</div>}
      </div>

      <div className="sftp-list snippet-list">
        {forwards.length === 0 && (
          <div className="host-empty">
            <p>暂无端口转发</p>
            <p className="host-empty-sub">填写上方表单，把本地端口通过 SSH 隧道转发到远端</p>
          </div>
        )}
        {forwards.map((f) => (
          <div className="fw-item" key={`${f.sessionId}:${f.localPort}`}>
            <div className="fw-item-main">
              <div className="fw-item-title">
                127.0.0.1:{f.localPort}
                <span className="fw-item-arrow">→</span>
                {f.remoteHost}:{f.remotePort}
              </div>
              <div className="fw-item-sub">
                经由 {f.host}
              </div>
            </div>
            <button
              className="mini-btn danger"
              title="移除转发"
              onClick={() => removeForward(f)}
            >
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 11v6M14 11v6" />
              </svg>
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
