import { useEffect, useState } from 'react';
import type { SavedHost } from '../types';

export interface ConnectConfig {
  name: string;
  host: string;
  port: number;
  username: string;
  password: string;
  group?: string;
}

interface Props {
  initial?: SavedHost | null;
  onClose: () => void;
  onSubmit: (cfg: ConnectConfig, persist: boolean) => void;
}

/** 新建连接时的默认预设（hadoop 环境） */
const NEW_CONNECTION_PRESET = {
  name: 'hadoop',
  host: '192.168.42.101',
  port: 22,
  username: 'root',
  password: '123456',
};

export default function ConnectionModal({ initial, onClose, onSubmit }: Props) {
  const [name, setName] = useState(initial?.name ?? NEW_CONNECTION_PRESET.name);
  const [host, setHost] = useState(initial?.host ?? NEW_CONNECTION_PRESET.host);
  const [port, setPort] = useState(initial?.port ?? NEW_CONNECTION_PRESET.port);
  const [username, setUsername] = useState(initial?.username ?? NEW_CONNECTION_PRESET.username);
  const [password, setPassword] = useState(initial?.password ?? NEW_CONNECTION_PRESET.password);
  const [group, setGroup] = useState(initial?.group ?? '');
  const [persist, setPersist] = useState(!initial);
  const [err, setErr] = useState('');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const submit = () => {
    if (!host.trim()) {
      setErr('请输入主机地址');
      return;
    }
    if (!username.trim()) {
      setErr('请输入用户名');
      return;
    }
    if (!password) {
      setErr('请输入密码');
      return;
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      setErr('端口号无效（1 - 65535）');
      return;
    }
    onSubmit(
      {
        name: name.trim() || host.trim(),
        host: host.trim(),
        port,
        username: username.trim(),
        password,
        group: group.trim() || undefined,
      },
      persist,
    );
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-header">
          <h2>{initial ? '编辑服务器' : '新建连接'}</h2>
          <button className="icon-btn" onClick={onClose} title="关闭">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>

        <div className="modal-body">
          <label className="field">
            <span>名称</span>
            <input
              value={name}
              placeholder="例如：生产服务器"
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submit()}
            />
          </label>
          <div className="field-row">
            <label className="field grow">
              <span>主机</span>
              <input
                value={host}
                placeholder="IP 或域名"
                autoFocus
                onChange={(e) => setHost(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && submit()}
              />
            </label>
            <label className="field port">
              <span>端口</span>
              <input
                type="number"
                value={port}
                min={1}
                max={65535}
                onChange={(e) => setPort(Number(e.target.value))}
                onKeyDown={(e) => e.key === 'Enter' && submit()}
              />
            </label>
          </div>
          <label className="field">
            <span>用户名</span>
            <input
              value={username}
              placeholder="root"
              onChange={(e) => setUsername(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submit()}
            />
          </label>
          <label className="field">
            <span>分组（可选）</span>
            <input
              value={group}
              placeholder="例如：教学集群 / 生产"
              onChange={(e) => setGroup(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submit()}
            />
          </label>
          <label className="field">
            <span>密码</span>
            <input
              type="password"
              value={password}
              placeholder="••••••••"
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submit()}
            />
          </label>

          {!initial && (
            <label className="check">
              <input type="checkbox" checked={persist} onChange={(e) => setPersist(e.target.checked)} />
              <span>保存到服务器列表（密码仅保存在本机）</span>
            </label>
          )}

          {err && <div className="form-error">{err}</div>}
        </div>

        <div className="modal-footer">
          <button className="btn ghost" onClick={onClose}>
            取消
          </button>
          <button className="btn primary" onClick={submit}>
            {initial ? '保存' : '连接'}
          </button>
        </div>
      </div>
    </div>
  );
}
