import { useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { setMonitorSession } from '../api';
import type { SysInfo } from '../types';
import { Spark } from './Spark';

interface Props {
  /** 当前活跃会话 ID，null 表示无连接 */
  sessionId: string | null;
  /** 会话显示的 host 名 */
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

function formatRate(n: number): string {
  if (n < 0) return '0 B/s';
  if (n < 1024) return `${Math.round(n)} B/s`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = -1;
  do {
    v /= 1024;
    i += 1;
  } while (v >= 1024 && i < units.length - 1);
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}/s`;
}

function pctColor(p: number): string {
  if (p >= 90) return 'var(--danger)';
  if (p >= 70) return 'var(--warn)';
  return 'var(--accent)';
}

const IconCpu = (
  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
    <rect x="6" y="6" width="12" height="12" rx="1.5" />
    <rect x="9.5" y="9.5" width="5" height="5" rx="0.8" />
    <path d="M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3" />
  </svg>
);

const IconMem = (
  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
    <rect x="3" y="6" width="18" height="12" rx="1.5" />
    <path d="M7 6v3M12 6v3M17 6v3M7 15v3M12 15v3M17 15v3" />
  </svg>
);

const IconNet = (
  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 20V5" />
    <path d="M6 11l6-6 6 6" />
    <path d="M17 19l4-4M20 16l1-1M7 19l-4-4M4 16l-1-1" />
  </svg>
);

const IconDisk = (
  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
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
  disk: number[];
}

const emptyHist: Hist = { cpu: [], mem: [], netRx: [], netTx: [], disk: [] };

function pushPoint(arr: number[], v: number): number[] {
  const next = arr.length >= HISTORY_MAX ? arr.slice(1) : arr.slice();
  next.push(v);
  return next;
}

// 迷你趋势曲线（smoothPath + Spark）已抽到公共组件 ../components/Spark，
// 供集群面板复用同一实现，避免两边各写一份导致漂移。

export default function ResourceMonitor({ sessionId, host }: Props) {
  const [info, setInfo] = useState<SysInfo | null>(null);
  const [hist, setHist] = useState<Hist>(emptyHist);
  // 历史镜像（供采样回调增量追加，避免依赖 state 闭包）
  const histRef = useRef<Hist>(emptyHist);
  // 网络曲线量程的 EMA 平滑值（避免量程随窗口峰值突变导致曲线上下跳动）
  const netPeakRef = useRef(1024 * 1024);

  useEffect(() => {
    setInfo(null);
    setHist(emptyHist);
    histRef.current = emptyHist;
    netPeakRef.current = 1024 * 1024;

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
      // 磁盘总用量百分比（聚合所有分区）
      const ds = s.disks ?? [];
      const dt = ds.reduce((a, d) => a + d.total, 0);
      const du = ds.reduce((a, d) => a + (d.total - d.available), 0);
      const dp = dt > 0 ? (du / dt) * 100 : 0;
      const prev = histRef.current;
      const nh: Hist = {
        cpu: pushPoint(prev.cpu, s.cpuPercent ?? 0),
        mem: pushPoint(prev.mem, s.memPercent ?? 0),
        netRx: pushPoint(prev.netRx, s.netRx ?? 0),
        netTx: pushPoint(prev.netTx, s.netTx ?? 0),
        disk: pushPoint(prev.disk, dp),
      };
      histRef.current = nh;
      setHist(nh);
      // 量程 EMA（非对称）：峰值上升时平缓跟随，回落时快速收敛，减少突发后的“压底尾迹”
      const target = Math.max(1024 * 1024, ...nh.netRx, ...nh.netTx) * 1.15;
      const peakNow = netPeakRef.current;
      const alpha = target >= peakNow ? 0.3 : 0.6;
      netPeakRef.current = peakNow + (target - peakNow) * alpha;
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
        <div className="rm-block" style={{ justifyContent: 'center', color: 'var(--text-faint)' }}>
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
  const diskTotal = disks.reduce((s, d) => s + d.total, 0);
  const diskUsed = disks.reduce((s, d) => s + (d.total - d.available), 0);
  const diskPct = diskTotal > 0 ? (diskUsed / diskTotal) * 100 : 0;
  const diskTooltip =
    disks.length === 0
      ? '磁盘'
      : disks.map((d) => `${d.name}  ${formatBytes(d.total - d.available)} / ${formatBytes(d.total)}`).join('\n');

  const title = host ? `${host} · ${info?.cpuBrand || 'CPU'}` : info?.cpuBrand || '加载中…';

  // 网络曲线量程：EMA 平滑后的峰值（渲染时读 ref 最新值）
  const netPeak = netPeakRef.current;

  return (
    <div className="resource-monitor">
      <div className="rm-block" title={title}>
        <Spark series={[{ values: hist.cpu, color: '#6fa8f6' }]} max={100} />
        <div className="rm-overlay">
          <span className="rm-icon rm-cpu">{IconCpu}</span>
          <span className="rm-name">CPU</span>
          <span className="rm-value" style={{ color: pctColor(cpuPct) }}>
            {cpuPct.toFixed(1)}%
          </span>
        </div>
      </div>

      <div className="rm-block" title="内存">
        <Spark series={[{ values: hist.mem, color: '#c792ea' }]} max={100} />
        <div className="rm-overlay">
          <span className="rm-icon rm-mem">{IconMem}</span>
          <span className="rm-name">内存</span>
          <span className="rm-value" style={{ color: pctColor(memPct) }}>
            {formatBytes(memUsed)} / {formatBytes(memTotal)}
          </span>
        </div>
      </div>

      <div className="rm-block" title="网络速率">
        <Spark
          series={[
            { values: hist.netRx, color: 'var(--net-down)' },
            { values: hist.netTx, color: 'var(--net-up)' },
          ]}
          max={netPeak}
        />
        <div className="rm-overlay">
          <span className="rm-icon rm-net">{IconNet}</span>
          <span className="rm-name">网络</span>
          <span className="rm-value rm-net-value">
            <span className="rm-down">↓ {formatRate(info?.netRx ?? 0)}</span>
            <span className="rm-up">↑ {formatRate(info?.netTx ?? 0)}</span>
          </span>
        </div>
      </div>

      <div className="rm-block" title={diskTooltip}>
        <Spark series={[{ values: hist.disk, color: '#e5c07b' }]} max={100} />
        <div className="rm-overlay">
          <span className="rm-icon rm-disk">{IconDisk}</span>
          <span className="rm-name">磁盘</span>
          <span className="rm-value" style={{ color: pctColor(diskPct) }}>
            {formatBytes(diskUsed)} / {formatBytes(diskTotal)}
          </span>
        </div>
      </div>
    </div>
  );
}