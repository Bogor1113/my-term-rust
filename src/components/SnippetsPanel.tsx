import { useEffect, useMemo, useState } from 'react';
import type { Snippet } from '../types';

const SNIPPETS_KEY = 'myterm.snippets';

function makeId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function loadSnippets(): Snippet[] {
  try {
    const raw = localStorage.getItem(SNIPPETS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item: unknown): item is Snippet =>
        typeof item === 'object' &&
        item !== null &&
        typeof (item as Record<string, unknown>).id === 'string' &&
        typeof (item as Record<string, unknown>).name === 'string' &&
        typeof (item as Record<string, unknown>).command === 'string',
    );
  } catch {
    return [];
  }
}

interface Props {
  onClose: () => void;
  /** 点击片段发送命令（是否广播由 App 侧决定） */
  onSend: (command: string) => void;
}

export default function SnippetsPanel({ onClose, onSend }: Props) {
  const [snippets, setSnippets] = useState<Snippet[]>(loadSnippets);
  const [showAdd, setShowAdd] = useState(false);
  const [name, setName] = useState('');
  const [command, setCommand] = useState('');
  const [group, setGroup] = useState('');

  useEffect(() => {
    try {
      localStorage.setItem(SNIPPETS_KEY, JSON.stringify(snippets));
    } catch {
      /* 存储失败时忽略 */
    }
  }, [snippets]);

  // Esc 关闭面板。焦点在终端或输入框内时按 Esc 是正常操作，不关闭。
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
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const grouped = useMemo(() => {
    const map = new Map<string, Snippet[]>();
    for (const s of snippets) {
      const g = (s.group && s.group.trim()) || '常用';
      const arr = map.get(g) ?? [];
      arr.push(s);
      map.set(g, arr);
    }
    return [...map.entries()];
  }, [snippets]);

  const addSnippet = () => {
    const nm = name.trim();
    const cmd = command.trim();
    if (!nm || !cmd) return;
    setSnippets((arr) => [...arr, { id: makeId(), name: nm, command: cmd, group: group.trim() || undefined }]);
    setName('');
    setCommand('');
    setGroup('');
    setShowAdd(false);
  };

  const removeSnippet = (id: string) => setSnippets((arr) => arr.filter((s) => s.id !== id));

  return (
    <div className="sftp-panel snippet-panel">
      <div className="sftp-header">
        <span className="sftp-title">命令片段</span>
        <div className="sftp-header-actions">
          <button className="icon-btn" title="新增片段" onClick={() => setShowAdd((v) => !v)}>
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>
          <button className="icon-btn" title="关闭" onClick={onClose}>
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>
      </div>

      {showAdd && (
        <div className="snippet-add">
          <input
            className="snippet-input"
            placeholder="名称（如：查看 HDFS 报告）"
            value={name}
            autoFocus
            onChange={(e) => setName(e.target.value)}
          />
          <textarea
            className="snippet-input snippet-textarea"
            placeholder="命令（如：hdfs dfsadmin -report）"
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                addSnippet();
              }
            }}
          />
          <input
            className="snippet-input"
            placeholder="分组（可选，如：教学实验）"
            value={group}
            onChange={(e) => setGroup(e.target.value)}
          />
          <div className="snippet-add-actions">
            <button className="btn primary" onClick={addSnippet} disabled={!name.trim() || !command.trim()}>
              添加
            </button>
          </div>
        </div>
      )}

      <div className="sftp-list snippet-list">
        {snippets.length === 0 && !showAdd && (
          <div className="host-empty">
            <p>还没有命令片段</p>
            <p className="host-empty-sub">点击右上角 ＋ 添加常用命令</p>
          </div>
        )}
        {grouped.map(([g, items]) => (
          <div key={g} className="snippet-group">
            <div className="snippet-group-title">{g}</div>
            {items.map((s) => (
              <div className="snippet-item" key={s.id}>
                <div
                  className="snippet-item-main"
                  title={s.command}
                  onClick={() => onSend(s.command)}
                >
                  <div className="snippet-item-name">{s.name}</div>
                  <div className="snippet-item-cmd">{s.command}</div>
                </div>
                <button className="mini-btn danger" title="删除" onClick={() => removeSnippet(s.id)}>
                  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 11v6M14 11v6" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
