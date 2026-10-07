import { useMemo, useState } from 'react';
import type { SavedHost } from '../types';

interface Props {
  hosts: SavedHost[];
  onConnect: (host: SavedHost) => void;
  onEdit: (host: SavedHost) => void;
  onDelete: (id: string) => void;
  onNew: () => void;
  /** 打开「集群监控」目标会话选择器 */
  onClusterClick: () => void;
  collapsed: boolean;
  onToggle: () => void;
  /** 显式创建的分组名列表 */
  groups?: string[];
  /** 打开分组管理弹窗 */
  onManageGroups?: () => void;
  /** 快速调整某台主机的分组 */
  onSetGroup?: (id: string, group: string) => void;
}

export default function Sidebar({
  hosts,
  onConnect,
  onEdit,
  onDelete,
  onNew,
  onClusterClick,
  collapsed,
  onToggle,
  groups = [],
  onManageGroups,
  onSetGroup,
}: Props) {
  const [query, setQuery] = useState('');

  // 所有可选分组（显式分组 + 主机上出现的分组），供快速下拉使用
  const allGroups = useMemo(() => {
    const set = new Set<string>(groups.filter((g) => g.trim()));
    for (const h of hosts) {
      const g = (h.group ?? '').trim();
      if (g) set.add(g);
    }
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [groups, hosts]);

  // 按分组归类 + 过滤
  const grouped = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? hosts.filter(
          (h) =>
            h.name.toLowerCase().includes(q) ||
            h.host.toLowerCase().includes(q) ||
            h.username.toLowerCase().includes(q) ||
            (h.group ?? '').toLowerCase().includes(q),
        )
      : hosts;
    const map = new Map<string, SavedHost[]>();
    for (const h of filtered) {
      const g = (h.group && h.group.trim()) || '未分组';
      const arr = map.get(g) ?? [];
      arr.push(h);
      map.set(g, arr);
    }
    return [...map.entries()];
  }, [hosts, query]);

  const totalCount = hosts.length;

  return (
    <aside className={`sidebar${collapsed ? ' collapsed' : ''}`}>
      <div className="sidebar-header">
        <span className="sidebar-title">服务器</span>
        <div className="sidebar-header-btns">
          <button className="icon-btn" title="管理分组" onClick={onManageGroups}>
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="7" height="7" rx="1.5" />
              <rect x="14" y="3" width="7" height="7" rx="1.5" />
              <rect x="3" y="14" width="7" height="7" rx="1.5" />
              <rect x="14" y="14" width="7" height="7" rx="1.5" />
            </svg>
          </button>
          <button className="icon-btn" title="收起服务器列表" onClick={onToggle}>
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M15 18l-6-6 6-6" />
            </svg>
          </button>
          <button className="icon-btn" title="新建连接" onClick={onNew}>
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>
        </div>
      </div>

      <div className="host-search">
        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <circle cx="11" cy="11" r="7" />
          <path d="M21 21l-4.3-4.3" />
        </svg>
        <input
          value={query}
          placeholder="搜索服务器…"
          onChange={(e) => setQuery(e.target.value)}
        />
        {query && (
          <button className="host-search-clear" title="清除" onClick={() => setQuery('')}>
            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        )}
      </div>

      <div className="host-list">
        {totalCount === 0 && (
          <div className="host-empty">
            <div className="host-empty-icon">
              <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                <rect x="3" y="4" width="18" height="12" rx="2" />
                <path d="M7 20h10M12 16v4" />
              </svg>
            </div>
            <p>还没有保存的服务器</p>
            <p className="host-empty-sub">点击右上角 ＋ 添加，或直接新建连接</p>
          </div>
        )}
        {totalCount > 0 && grouped.length === 0 && (
          <div className="host-empty">
            <p>没有匹配「{query}」的服务器</p>
          </div>
        )}

        {grouped.map(([g, items]) => (
          <div key={g} className="host-group">
            <div className="host-group-title">
              {g}
              <span className="host-group-count">{items.length}</span>
            </div>
            {items.map((h) => (
              <div className="host-item" key={h.id}>
                <div
                  className="host-info"
                  title={`${h.username}@${h.host}:${h.port}`}
                  onClick={() => onConnect(h)}
                >
                  <div className="host-name">{h.name}</div>
                  <div className="host-meta">
                    {h.username}@{h.host}
                    <span className="host-port">:{h.port}</span>
                  </div>
                </div>
                <div className="host-actions">
                  <select
                    className="host-group-select"
                    title="所属分组"
                    value={h.group ?? ''}
                    onChange={(e) => onSetGroup?.(h.id, e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <option value="">未分组</option>
                    {allGroups
                      .filter((g) => g !== (h.group ?? ''))
                      .map((g) => (
                        <option key={g} value={g}>
                          {g}
                        </option>
                      ))}
                  </select>
                  <button className="mini-btn" title="编辑" onClick={() => onEdit(h)}>
                    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
                    </svg>
                  </button>
                  <button className="mini-btn danger" title="删除" onClick={() => onDelete(h.id)}>
                    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 11v6M14 11v6" />
                    </svg>
                  </button>
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>

      <div className="sidebar-cluster">
        <button className="cluster-entry" onClick={onClusterClick} title="打开集群监控（需先连接 SSH 会话）">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="4" width="18" height="7" rx="2" />
            <rect x="3" y="13" width="18" height="7" rx="2" />
            <path d="M7 7.5h.01M7 16.5h.01" strokeLinecap="round" />
            <path d="M12 11v2" />
          </svg>
          集群监控
        </button>
      </div>

      <div className="sidebar-footer">点击服务器名称即可连接</div>
    </aside>
  );
}
