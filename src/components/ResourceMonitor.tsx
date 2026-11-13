import { useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { setMonitorSession } from '../api';
import type { SysInfo } from '../types';
import { Spark } from './Spark';

interface Props {
  /** 当前活跃会话 ID，null 表示无连接 */
  sessionId: string | null;
  /** 会话显示的 host 名（username@host） */
  host?: string;
}

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0 B';
  if (n < 1024) return `${Math.round(n)} B`;
  const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let v = n;
  let i = -1;
  do {
    v /= 1024;
    i += 1;
  } while (v >= 1024 && i < units.length - 1);
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/** MobaXterm 风格的网速显示：恒定 Mb/s（兆比特/秒）单位 */
function formatMb(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0.00 Mb/s';
  const mbps = (n * 8) / 1_000_000;
  if (mbps >= 100) return `${Math.round(mbps)} Mb/s`;
  if (mbps >= 1) return `${mbps.toFixed(2)} Mb/s`;
  return `${mbps.toFixed(2)} Mb/s`;
}

/** MobaXterm 风格的运行时长：42 hours / 3 days / 5 min */
function formatUptime(secs: number): string {
  if (!Number.isFinite(secs) || secs <= 0) return '—';
  const days = Math.floor(secs / 86400);
  const hours = Math.floor((secs % 86400) / 3600);
  const mins = Math.floor((secs % 3600) / 60);
  if (days >= 2) return `${days} days`;
  if (days === 1) return `1 day ${hours} h`;
  if (hours >= 1) return `${hours} hour${hours > 1 ? 's' : ''}`;
  if (mins >= 1) return `${mins} min`;
  return '<1 min';
}

/** 百分比型指标（CPU / 内存 / 磁盘）的三档配色阈值 */
const PCT_WARN = 70; // ≥70% 黄色
const PCT_DANGER = 90; // ≥90% 红色
/** 网络速率的三档配色阈值（Mb/s，兆比特/秒；无链路容量数据，按绝对速率分档） */
const RATE_WARN_MBPS = 30;
const RATE_DANGER_MBPS = 100;

function pctColor(p: number): string {
  if (p >= PCT_DANGER) return 'var(--danger)';
  if (p >= PCT_WARN) return 'var(--warn)';
  return 'var(--accent)';
}

/** 网络速率配色：与 CPU/内存/磁盘同一套蓝→黄→红 */
function rateColor(bytesPerSec: number): string {
  const mbps = ((Number.isFinite(bytesPerSec) ? bytesPerSec : 0) * 8) / 1e6;
  if (mbps >= RATE_DANGER_MBPS) return 'var(--danger)';
  if (mbps >= RATE_WARN_MBPS) return 'var(--warn)';
  return 'var(--accent)';
}

const IconCpu = (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
    <rect x="6" y="6" width="12" height="12" rx="1.5" />
    <rect x="9.5" y="9.5" width="5" height="5" rx="0.8" />
    <path d="M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3" />
  </svg>
);

const IconMem = (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
    <rect x="3" y="6" width="18" height="12" rx="1.5" />
    <path d="M7 6v3M12 6v3M17 6v3M7 15v3M12 15v3M17 15v3" />
  </svg>
);

const IconServer = (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="4" width="18" height="7" rx="2" />
    <rect x="3" y="13" width="18" height="7" rx="2" />
    <path d="M7 7.5h.01M7 16.5h.01" strokeLinecap="round" />
  </svg>
);

const IconDown = (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 4v13M6 12l6 6 6-6" />
  </svg>
);

const IconUp = (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 20V7M6 12l6-6 6 6" />
  </svg>
);

const IconClock = (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7v5l3.5 2" />
  </svg>
);

const IconUser = (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="8" r="3.5" />
    <path d="M5 20a7 7 0 0 1 14 0" />
  </svg>
);

const IconDisk = (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
    <rect x="3" y="4.5" width="18" height="15" rx="2.5" />
    <path d="M7 8h.01M10 8h.01" />
    <path d="M6 15.5h12" opacity="0.55" />
  </svg>
);

// ---------- 历史曲线 ----------
// 每 1 秒一个采样点，保留 60 点（约 1 分钟窗口）
const HISTORY_MAX = 60;

interface Hist {
  cpu: number[];
  mem: number[];
  netRx: number[];
  netTx: number[];
}

const emptyHist: Hist = { cpu: [], mem: [], netRx: [], netTx: [] };

function pushPoint(arr: number[], v: number): number[] {
  const next = arr.length >= HISTORY_MAX ? arr.slice(1) : arr.slice();
  next.push(v);
  return next;
}

export default function ResourceMonitor({ sessionId, host }: Props) {
  const [info, setInfo] = useState<SysInfo | null>(null);
  const [hist, setHist] = useState<Hist>(emptyHist);
  // 历史镜像（供采样回调增量追加，避免依赖 state 闭包）
  const histRef = useRef<Hist>(emptyHist);

  useEffect(() => {
    setInfo(null);
    setHist(emptyHist);
    histRef.current = emptyHist;

    // 只让后端采集「当前正在查看」的会话：其余已连接会话不再每 3 秒打一轮
    // SSH（它们的数据没有任何订阅者）。切换标签时旧会话自动停止采集。
    void setMonitorSession(sessionId).catch(() => {});

    if (!sessionId) return;

    let disposed = false;
    let unlisten: (() => void) | undefined;

    listen<SysInfo>(`session-sys-info-${sessionId}`, (e) => {
      if (disposed) return;
      const s = e.payload;
      setInfo(s);
      const prev = histRef.current;
      const nh: Hist = {
        cpu: pushPoint(prev.cpu, s.cpuPercent ?? 0),
        mem: pushPoint(prev.mem, s.memPercent ?? 0),
        netRx: pushPoint(prev.netRx, s.netRx ?? 0),
        netTx: pushPoint(prev.netTx, s.netTx ?? 0),
      };
      histRef.current = nh;
      setHist(nh);
    })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => {});

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [sessionId]);

  if (!sessionId) {
    return (
      <div className="resource-monitor">
        <div className="rm-block rm-empty" style={{ justifyContent: 'center', color: 'var(--text-faint)' }}>
          <span style={{ fontSize: 12 }}>未连接服务器，资源监控无数据</span>
        </div>
      </div>
    );
  }

  const cpuPct = info?.cpuPercent ?? 0;
  const memTotal = info?.memTotal ?? 0;
  const memUsed = info?.memUsed ?? 0;
  const memPct = info?.memPercent ?? 0;
  const disks = info?.disks ?? [];
  const diskTooltip =
    disks.length === 0
      ? '磁盘'
      : disks.map((d) => `${d.name}  ${formatBytes(d.total - d.available)} / ${formatBytes(d.total)} (${Math.round(d.percent)}%)`).join('\n');

  // 磁盘格显示根分区占用（MobaXterm 风格 "/: 33%"）；无 / 时取容量最大的分区
  const rootDisk =
    disks.find((d) => d.name === '/') ??
    disks.reduce<typeof disks[number] | null>(
      (best, d) => (!best || d.total > best.total ? d : best),
      null,
    );

  // MobaXterm 风格的主机名：显示 host 部分（如 hadoop101）
  const hostLabel = (host ?? '').split('@').pop() || info?.host || '—';

  // 登录用户格：root (x2) / 3 users / —
  const userCount = info?.userCount ?? 0;
  const topUser = info?.topUser ?? '';
  const userLabel =
    userCount > 0 ? (topUser ? `${topUser} (x${userCount})` : `${userCount} users`) : '—';

  return (
    <div className="resource-monitor">
      <div className="rm-block rm-host" title={host ? `${host} · ${info?.cpuBrand || 'CPU'}` : info?.cpuBrand || '加载中…'}>
        <span className="rm-icon rm-server">{IconServer}</span>
        <span className="rm-host-name">{hostLabel}</span>
      </div>

      <div className="rm-block rm-cpu-block" title={info?.cpuBrand || 'CPU'}>
        <Spark series={[{ values: hist.cpu, color: 'var(--accent)' }]} max={100} />
        <span className="rm-icon rm-cpu" style={{ color: pctColor(cpuPct) }}>{IconCpu}</span>
        <span className="rm-value" style={{ color: pctColor(cpuPct) }}>
          {cpuPct.toFixed(1)}%
        </span>
      </div>

      <div className="rm-block" title="内存">
        <span className="rm-icon rm-mem" style={{ color: pctColor(memPct) }}>{IconMem}</span>
        <span className="rm-value" style={{ color: pctColor(memPct) }}>
          {formatBytes(memUsed)} / {formatBytes(memTotal)}
        </span>
      </div>

      <div className="rm-block" title={`上行速率（≥${RATE_WARN_MBPS} Mb/s 黄色，≥${RATE_DANGER_MBPS} Mb/s 红色）`}>
        <span className="rm-icon rm-up" style={{ color: rateColor(info?.netTx ?? 0) }}>{IconUp}</span>
        <span className="rm-value" style={{ color: rateColor(info?.netTx ?? 0) }}>{formatMb(info?.netTx ?? 0)}</span>
      </div>

      <div className="rm-block" title={`下行速率（≥${RATE_WARN_MBPS} Mb/s 黄色，≥${RATE_DANGER_MBPS} Mb/s 红色）`}>
        <span className="rm-icon rm-down" style={{ color: rateColor(info?.netRx ?? 0) }}>{IconDown}</span>
        <span className="rm-value" style={{ color: rateColor(info?.netRx ?? 0) }}>{formatMb(info?.netRx ?? 0)}</span>
      </div>

      <div className="rm-block" title="系统运行时长">
        <span className="rm-icon rm-clock">{IconClock}</span>
        <span className="rm-value">{formatUptime(info?.uptimeSecs ?? 0)}</span>
      </div>

      <div className="rm-block" title="登录用户">
        <span className="rm-icon rm-user">{IconUser}</span>
        <span className="rm-value">{userLabel}</span>
      </div>

      <div className="rm-block" title={diskTooltip}>
        <span className="rm-icon rm-disk" style={{ color: pctColor(rootDisk?.percent ?? 0) }}>{IconDisk}</span>
        <span className="rm-value" style={{ color: pctColor(rootDisk?.percent ?? 0) }}>
          {rootDisk ? `${rootDisk.name}: ${Math.round(rootDisk.percent)}%` : '磁盘 —'}
        </span>
      </div>
    </div>
  );
}
