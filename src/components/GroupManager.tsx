import { useMemo, useState } from 'react';
import type { SavedHost } from '../types';

interface Props {
  /** 显式创建的分组名列表（含可能暂无主机的空分组） */
  groups: string[];
  hosts: SavedHost[];
  onAddGroup: (name: string) => void;
  onRenameGroup: (oldName: string, newName: string) => void;
  onDeleteGroup: (name: string) => void;
  onClose: () => void;
}

export default function GroupManager({
  groups,
  hosts,
  onAddGroup,
  onRenameGroup,
  onDeleteGroup,
  onClose,
}: Props) {
  const [newName, setNewName] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [confirmDel, setConfirmDel] = useState<string | null>(null);

  // 分组 = 显式分组 + 主机上出现的分组（取并集），并统计每组合计主机数
  const entries = useMemo(() => {
    const set = new Set<string>();
    for (const g of groups) set.add(g.trim());
    for (const h of hosts) {
      const g = (h.group ?? '').trim();
      if (g) set.add(g);
    }
    const counts = new Map<string, number>();
    for (const h of hosts) {
      const g = (h.group ?? '').trim() || '未分组';
      counts.set(g, (counts.get(g) ?? 0) + 1);
    }
    return [...set].sort((a, b) => a.localeCompare(b)).map((g) => ({
      name: g,
      count: counts.get(g) ?? 0,
    }));
  }, [groups, hosts]);

  const addGroup = () => {
    const name = newName.trim();
    if (!name) return;
    onAddGroup(name);
    setNewName('');
  };

  const commitRename = () => {
    if (editing === null) return;
    const name = draft.trim();
    if (name && name !== editing) onRenameGroup(editing, name);
    setEditing(null);
    setDraft('');
  };

  const handleDelete = (name: string) => {
    onDeleteGroup(name);
    setConfirmDel(null);
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal group-manager">
        <div className="modal-header">
          <h2>管理分组</h2>
          <button className="icon-btn" title="关闭" onClick={onClose}>
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>

        <div className="modal-body">
          <div className="gm-add">
            <input
              className="gm-add-input"
              value={newName}
              placeholder="新分组名称…"
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') addGroup();
              }}
            />
            <button className="btn primary" onClick={addGroup} disabled={!newName.trim()}>
              添加
            </button>
          </div>

          <div className="gm-list">
            {entries.length === 0 && (
              <p className="gm-empty">暂无分组，先添加一个吧</p>
            )}
            {entries.map((g) => (
              <div key={g.name} className="gm-item">
                {editing === g.name ? (
                  <input
                    className="gm-edit-input"
                    value={draft}
                    autoFocus
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitRename();
                      if (e.key === 'Escape') {
                        setEditing(null);
                        setDraft('');
                      }
                    }}
                    onBlur={commitRename}
                  />
                ) : (
                  <div className="gm-item-name" onDoubleClick={() => { setEditing(g.name); setDraft(g.name); }}>
                    {g.name}
                    <span className="gm-item-count">{g.count}</span>
                  </div>
                )}

                {confirmDel === g.name ? (
                  <div className="gm-confirm">
                    <span>删除分组？{g.count > 0 ? `将清空 ${g.count} 台主机分组` : ''}</span>
                    <button className="mini-btn danger" onClick={() => handleDelete(g.name)}>删除</button>
                    <button className="mini-btn" onClick={() => setConfirmDel(null)}>取消</button>
                  </div>
                ) : (
                  <div className="gm-actions">
                    <button
                      className="mini-btn"
                      title="重命名（双击名称亦可）"
                      onClick={() => { setEditing(g.name); setDraft(g.name); }}
                    >
                      <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
                      </svg>
                    </button>
                    <button className="mini-btn danger" title="删除分组" onClick={() => setConfirmDel(g.name)}>
                      <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 11v6M14 11v6" />
                      </svg>
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>

          <p className="gm-hint">
            提示：双击分组名可重命名；删除分组会把该组所有主机移回「未分组」。在连接/编辑弹窗的「分组」字段也能随时调整主机所属分组。
          </p>
        </div>
      </div>
    </div>
  );
}
