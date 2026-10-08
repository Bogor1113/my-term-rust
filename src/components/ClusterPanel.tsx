import { useCallback, useEffect, useRef, useState } from 'react';
import { openUrl } from '@tauri-apps/plugin-opener';
import {
  clusterHdfsList,
  clusterHdfsNodes,
  clusterHdfsSummary,
  clusterListServices,
  clusterNameNodeJvm,
  clusterServiceAction,
  clusterServiceLogs,
  clusterWebUrl,
  clusterYarnApps,
  clusterYarnKill,
  clusterYarnMetrics,
  clusterYarnNodes,
} from '../api';
import type {
  ClusterServiceInfo,
  HdfsEntry,
  HdfsNodes,
  HdfsSummary,
  NameNodeJvm,
  TabInfo,
  YarnApp,
  YarnMetrics,
  YarnNode,
} from '../types';

type ServiceAction = 'start' | 'stop' | 'restart';

/** 确认操作（服务启停 / YARN 终止） */
interface ConfirmReq {
  title: string;
  message: string;
  busyText: string;
  run: () => Promise<string>;
}

/** 日志抽屉内容 */
interface LogReq {
  key: string;
  name: string;
  content: string;
  loading: boolean;
}

const SERVICE_KEYS = ['HDFS', 'YARN', 'Hive', 'DolphinScheduler', 'MySQL', 'SparkMaster', 'SparkWorker'];

/** 操作动作的中文文案 */
const actionText = (a: ServiceAction): string =>
  a === 'start' ? '启动' : a === 'stop' ? '停止' : '重启';

function statusClass(s: string): string {
  switch (s) {
    case 'running':
      return 'ok';
    case 'stopped':
      return 'down';
    case 'degraded':
      return 'warn';
    default:
      return '';
  }
}

function statusText(s: string): string {
  switch (s) {
    case 'running':
      return '运行中';
    case 'stopped':
      return '已停止';
    case 'degraded':
      return '部分运行';
    default:
      return '未知';
  }
}

/** 格式化 HDFS 大小：兼容纯字节数（换算成 KB/MB/GB）与后端已格式化的
 *  可读大小（如 "160K"、"1.2G"、"160 K"），统一显示为 "160 KB" 风格 */
function formatSize(raw: string): string {
  const s = String(raw).trim();
  const n = Number(s);
  if (Number.isFinite(n) && n >= 0 && /^\d+$/.test(s)) {
    // 纯数字：按字节换算
    const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
    let v = n;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) {
      v /= 1024;
      i += 1;
    }
    const num = v >= 100 || i === 0 ? String(Math.round(v)) : v.toFixed(1);
    return `${num} ${units[i]}`;
  }
  // 已是可读格式（可能含空格，如 "160 K"）→ 规范为 "160 KB"
  const m = s.match(/^([\d.]+)\s*([KMGT])$/i);
  if (m) {
    return `${Number(m[1])} ${m[2].toUpperCase()}B`;
  }
  return s;
}

/** epoch ms → "X 分钟前 / X 小时前"（checkpoint、心跳、启动时间用） */
function sinceText(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '未知';
  const secs = Math.floor((Date.now() - ms) / 1000);
  if (secs < 0) return '未知';
  if (secs < 60) return `${secs} 秒前`;
  if (secs < 3600) return `${Math.floor(secs / 60)} 分钟前`;
  if (secs < 86400) return `${Math.floor(secs / 3600)} 小时前`;
  return `${Math.floor(secs / 86400)} 天前`;
}

/** checkpoint 滞后告警阈值：Hadoop 默认每 100 万事务触发一次 checkpoint，
 *  这里取 10% 作为「已经开始积压」的预警线 */
const CHECKPOINT_GAP_WARN = 100000;

/** 一条集群健康告警 */
interface HealthIssue {
  level: 'danger' | 'warn';
  text: string;
}

/**
 * 汇总集群健康异常，全部来自已经取到的四个视图，不额外发请求。
 *
 * 目的：把散落在各图表里的异常信号聚成一行结论——现在是"你自己逐个比对数字"，
 * 异常时才有内容，正常时整条不出现（不占视觉噪音）。
 */
function collectHealthIssues(
  h: HdfsSummary | null,
  dn: HdfsNodes | null,
  ym: YarnMetrics | null,
  nodes: YarnNode[] | null,
): HealthIssue[] {
  const issues: HealthIssue[] = [];
  if (h) {
    if (h.missingBlocks > 0) issues.push({ level: 'danger', text: `缺失块 ${h.missingBlocks}` });
    if (h.corruptBlocks > 0) issues.push({ level: 'danger', text: `损坏块 ${h.corruptBlocks}` });
    if (h.deadDatanodes > 0)
      issues.push({ level: 'danger', text: `掉线 DataNode ${h.deadDatanodes}` });
    if (h.underReplicatedBlocks > 0)
      issues.push({ level: 'warn', text: `副本不足块 ${h.underReplicatedBlocks}` });
    if (h.pendingDeletionBlocks > 0)
      issues.push({ level: 'warn', text: `待删除块 ${h.pendingDeletionBlocks}` });
    if (h.transactionsSinceLastCheckpoint > 0 && !dn)
      issues.push({
        level: 'warn',
        text: `距上次 checkpoint 已 ${h.transactionsSinceLastCheckpoint.toLocaleString()} 个事务`,
      });
    // 磁盘占用 = DFS 已用 + 非 HDFS 占用（这才是 `df` 看到的量）
    const diskTotal = h.capacityTotalGb + h.capacityUsedNonDfsGb;
    const diskUsed = h.capacityUsedGb + h.capacityUsedNonDfsGb;
    if (diskTotal > 0 && diskUsed / diskTotal >= 0.85)
      issues.push({
        level: 'danger',
        text: `磁盘占用 ${Math.round((diskUsed / diskTotal) * 100)}%`,
      });
  }
  if (dn) {
    if (dn.safemode) issues.push({ level: 'danger', text: 'NameNode 处于安全模式（HDFS 只读）' });
    if (dn.deadNodes > 0) issues.push({ level: 'danger', text: `Dead DataNode ${dn.deadNodes}` });
    if (dn.corruptFiles > 0) issues.push({ level: 'danger', text: `损坏文件 ${dn.corruptFiles}` });
    // NameNode 自己的元数据目录故障：从容量/块统计完全看不出来，必须单独告警
    if (dn.failedDirs.length > 0)
      issues.push({ level: 'danger', text: `NameNode 元数据目录故障 ${dn.failedDirs.length}` });
    // checkpoint 滞后优先用 JournalTransactionInfo 差值（比 FSNamesystem 的计数更权威）
    if (dn.checkpointGap > CHECKPOINT_GAP_WARN)
      issues.push({
        level: 'warn',
        text: `距上次 checkpoint 已 ${dn.checkpointGap.toLocaleString()} 个事务`,
      });
    const volFail = dn.nodes.reduce((s, n) => s + (n.volFails || 0), 0);
    if (volFail > 0) issues.push({ level: 'danger', text: `磁盘卷故障 ${volFail}` });
  }
  if (ym) {
    if (ym.lostNodes > 0) issues.push({ level: 'danger', text: `丢失 NodeManager ${ym.lostNodes}` });
    if (ym.unhealthyNodes > 0)
      issues.push({ level: 'danger', text: `不可用 NodeManager ${ym.unhealthyNodes}` });
  }
  if (nodes) {
    const unhealthy = nodes.filter((n) => n.healthReport && n.healthReport.trim() !== '');
    if (unhealthy.length > 0)
      issues.push({ level: 'danger', text: `NodeManager 健康检查失败 ${unhealthy.length}` });
  }
  return issues;
}

/** HDFS 存储与块统计图表（环形用量 + 块/节点统计） */
function HdfsChart({ h }: { h: HdfsSummary }) {
  // 数据合法性检查：防止因后端返回异常数据导致界面展示异常文本
  if (!h || !Number.isFinite(h.capacityTotalGb)) {
    return (
      <div className="cluster-chart-empty">
        数据获取失败，请刷新
      </div>
    );
  }
  const fmtGb = (v: number) => `${v.toFixed(1)} GB`;
  // 磁盘视角：同一块盘上既有 HDFS 数据，也有其它进程/系统的占用（NonDFS）。
  // 只画「DFS 已用 / 容量」会显示成"磁盘几乎全空"（本机实测 0.1 / 58.8 GB），
  // 与 `df` 实际占用严重不符——两段一起算才对得上，环形中央改为"磁盘占用"。
  const total = Math.max(h.capacityTotalGb, 0);
  const dfsUsed = Math.min(Math.max(h.capacityUsedGb, 0), total || Number.MAX_VALUE);
  const nonDfs = Math.min(Math.max(h.capacityUsedNonDfsGb, 0), Math.max(total - dfsUsed, 0));
  const dfsPct = total > 0 ? (dfsUsed / total) * 100 : 0;
  const nonDfsPct = total > 0 ? (nonDfs / total) * 100 : 0;
  const stop1 = Math.min(100, dfsPct + nonDfsPct);
  const diskPct = Math.round(stop1);
  return (
    <>
      <div className="cluster-donut-wrap">
        <div
          className="cluster-donut"
          style={{
            background: `conic-gradient(var(--accent) 0% ${dfsPct}%, var(--warn) ${dfsPct}% ${stop1}%, var(--bg-hover) ${stop1}% 100%)`,
          }}
        >
          <div className="cluster-donut-inner">
            <b>{diskPct}%</b>
            <span>磁盘占用</span>
          </div>
        </div>
        <div className="cluster-legend">
          <div className="cluster-legend-row">
            <span className="cluster-legend-dot" style={{ background: 'var(--bg-hover)' }} />
            总容量
            <span className="val">{fmtGb(h.capacityTotalGb)}</span>
          </div>
          <div className="cluster-legend-row">
            <span className="cluster-legend-dot" style={{ background: 'var(--accent)' }} />
            DFS 已用
            <span className="val">{fmtGb(h.capacityUsedGb)}</span>
          </div>
          <div className="cluster-legend-row">
            <span className="cluster-legend-dot" style={{ background: 'var(--warn)' }} />
            非 HDFS 占用
            <span className="val">{fmtGb(h.capacityUsedNonDfsGb)}</span>
          </div>
          <div className="cluster-legend-row">
            <span className="cluster-legend-dot" style={{ background: 'var(--green)' }} />
            剩余可用
            <span className="val">{fmtGb(h.capacityRemainingGb)}</span>
          </div>
        </div>
      </div>
      <div className="cluster-chart-tiles">
        <div className="cluster-chart-tile">
          <b>{h.totalBlocks.toLocaleString()}</b>
          <span>总块数</span>
        </div>
        <div className="cluster-chart-tile">
          <b style={h.missingBlocks > 0 ? { color: 'var(--danger)' } : undefined}>
            {h.missingBlocks.toLocaleString()}
          </b>
          <span>缺失块</span>
        </div>
        <div className="cluster-chart-tile">
          <b style={h.underReplicatedBlocks > 0 ? { color: 'var(--warn)' } : undefined}>
            {h.underReplicatedBlocks.toLocaleString()}
          </b>
          <span>副本不足</span>
        </div>
        <div className="cluster-chart-tile">
          <b>{h.liveDatanodes}</b>
          <span>存活 DataNode</span>
        </div>
        <div className="cluster-chart-tile">
          <b>{h.totalFiles.toLocaleString()}</b>
          <span>文件数</span>
        </div>
        <div className="cluster-chart-tile">
          <b style={h.deadDatanodes > 0 ? { color: 'var(--danger)' } : undefined}>
            {h.deadDatanodes}
          </b>
          <span>异常 DataNode</span>
        </div>
      </div>
    </>
  );
}

/** YARN 总资源图表（内存 / vCore 使用条 + 节点与应用统计） */
function YarnChart({ m }: { m: YarnMetrics }) {
  // 数据合法性检查
  if (!m || !Number.isFinite(m.totalMb)) {
    return (
      <div className="cluster-chart-empty">
        数据获取失败，请刷新
      </div>
    );
  }
  const gb = (mb: number) => `${(mb / 1024).toFixed(1)} GB`;
  const memPct =
    m.totalMb > 0 ? Math.min(100, Math.round((m.allocatedMb / m.totalMb) * 100)) : 0;
  const vcPct =
    m.totalVcores > 0 ? Math.min(100, Math.round((m.allocatedVcores / m.totalVcores) * 100)) : 0;
  return (
    <>
      <div className="cluster-resource">
        <div className="cluster-resource-top">
          <span>内存</span>
          <span className="mono">
            {gb(m.allocatedMb)} / {gb(m.totalMb)}
          </span>
        </div>
        <div className="cluster-resource-bar">
          <div
            className="cluster-resource-fill"
            style={{ width: `${memPct}%`, background: 'var(--accent)' }}
          />
        </div>
      </div>
      <div className="cluster-resource">
        <div className="cluster-resource-top">
          <span>vCore</span>
          <span className="mono">
            {m.allocatedVcores} / {m.totalVcores}
          </span>
        </div>
        <div className="cluster-resource-bar">
          <div
            className="cluster-resource-fill"
            style={{ width: `${vcPct}%`, background: 'var(--green)' }}
          />
        </div>
      </div>
      <div className="cluster-chart-tiles">
        <div className="cluster-chart-tile">
          <b>{m.activeNodes}</b>
          <span>活跃节点</span>
        </div>
        <div className="cluster-chart-tile">
          <b style={m.lostNodes > 0 ? { color: 'var(--danger)' } : undefined}>{m.lostNodes}</b>
          <span>丢失节点</span>
        </div>
        <div className="cluster-chart-tile">
          <b>{m.runningApps}</b>
          <span>运行中应用</span>
        </div>
        <div className="cluster-chart-tile">
          <b>{m.pendingApps}</b>
          <span>待运行应用</span>
        </div>
        <div className="cluster-chart-tile">
          <b style={m.unhealthyNodes > 0 ? { color: 'var(--danger)' } : undefined}>
            {m.unhealthyNodes}
          </b>
          <span>不可用节点</span>
        </div>
        <div className="cluster-chart-tile">
          <b>{m.containersAllocated}</b>
          <span>已分配容器</span>
        </div>
      </div>
      {/* 累计任务数（自 RM 启动）：教学场景直接回答"这次课提交了几个作业、几个失败" */}
      <div className="cluster-node-foot">
        累计任务 提交 {m.appsSubmitted} · 完成 {m.appsCompleted} · 失败{' '}
        <b className={m.appsFailed > 0 ? 'danger' : undefined}>{m.appsFailed}</b> · 终止 {m.appsKilled}
        <div className="mono">节点物理内存利用率 {Math.round(m.utilizedMbPercent)}%</div>
      </div>
    </>
  );
}

/** NameNode JVM 统计图表（堆内存条 + GC/线程磁贴） */
function JvmChart({ j }: { j: NameNodeJvm }) {
  // 数据合法性检查
  if (!j || !Number.isFinite(j.heapCommittedMb)) {
    return (
      <div className="cluster-chart-empty">
        数据获取失败，请刷新
      </div>
    );
  }
  const gb = (mb: number) => `${(mb / 1024).toFixed(1)} GB`;
  const pct =
    j.heapCommittedMb > 0
      ? Math.min(100, Math.round((j.heapUsedMb / j.heapCommittedMb) * 100))
      : 0;
  return (
    <>
      <div className="cluster-resource">
        <div className="cluster-resource-top">
          <span>堆内存</span>
          <span className="mono">
            {gb(j.heapUsedMb)} / {gb(j.heapCommittedMb)}
          </span>
        </div>
        <div className="cluster-resource-bar">
          <div
            className="cluster-resource-fill"
            style={{ width: `${pct}%`, background: 'var(--warn)' }}
          />
        </div>
        <div className="cluster-resource-sub mono">堆上限 {gb(j.heapMaxMb)}</div>
      </div>
      <div className="cluster-chart-tiles">
        <div className="cluster-chart-tile">
          <b>{j.gcCount}</b>
          <span>GC 次数</span>
        </div>
        <div className="cluster-chart-tile">
          <b>{(j.gcTimeMs / 1000).toFixed(1)}s</b>
          <span>GC 累计耗时</span>
        </div>
        <div className="cluster-chart-tile">
          <b>{j.threads}</b>
          <span>线程数</span>
        </div>
        <div className="cluster-chart-tile">
          <b>{gb(j.heapMaxMb)}</b>
          <span>堆上限</span>
        </div>
      </div>
    </>
  );
}

/** NodeManager 资源占用（RM /ws/v1/cluster/nodes） */
function YarnNodeList({ nodes }: { nodes: YarnNode[] }) {
  if (nodes.length === 0) {
    return <div className="cluster-chart-empty">暂无可用 NodeManager</div>;
  }
  return (
    <div className="cluster-node-list">
      {nodes.map((n) => {
        const memTotal = n.usedMemoryMb + n.availableMemoryMb;
        const memPct = memTotal > 0 ? Math.round((n.usedMemoryMb / memTotal) * 100) : 0;
        const vcTotal = n.usedVcores + n.availableVcores;
        const vcPct = vcTotal > 0 ? Math.round((n.usedVcores / vcTotal) * 100) : 0;
        const unhealthy = !!n.healthReport && n.healthReport.trim() !== '';
        return (
          <div className="cluster-node" key={n.id}>
            <div className="cluster-node-head">
              <span className="cluster-node-name" title={n.nodeHttpAddress || n.rack}>
                {n.id}
              </span>
              <span
                className={`cluster-badge ${unhealthy ? 'down' : n.state === 'RUNNING' ? 'ok' : 'warn'}`}
                title={n.healthReport || undefined}
              >
                {unhealthy ? '不健康' : n.state}
              </span>
            </div>
            <div className="cluster-resource">
              <div className="cluster-resource-top">
                <span>内存</span>
                <span className="mono">
                  {n.usedMemoryMb} / {memTotal} MB
                </span>
              </div>
              <div className="cluster-resource-bar">
                <div
                  className="cluster-resource-fill"
                  style={{ width: `${memPct}%`, background: 'var(--accent)' }}
                />
              </div>
            </div>
            <div className="cluster-resource">
              <div className="cluster-resource-top">
                <span>vCore</span>
                <span className="mono">
                  {n.usedVcores} / {vcTotal}
                </span>
              </div>
              <div className="cluster-resource-bar">
                <div
                  className="cluster-resource-fill"
                  style={{ width: `${vcPct}%`, background: 'var(--green)' }}
                />
              </div>
            </div>
            <div className="cluster-node-grid">
              <span>容器数</span>
              <b>{n.numContainers}</b>
              <span>物理内存</span>
              <b>{n.memUtilization ? `${Math.round(n.memUtilization)}%` : '—'}</b>
              <span>心跳</span>
              <b>{sinceText(n.lastHealthUpdateMs)}</b>
            </div>
            {unhealthy && (
              <span className="cluster-svc-error" title={n.healthReport}>
                {n.healthReport}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

export default function ClusterPanel({
  tab,
  active = true,
  splitPane = false,
}: {
  tab: TabInfo;
  /** 当前标签是否处于激活状态（未激活时隐藏，避免内容穿透到其它终端页面） */
  active?: boolean;
  /** 分屏中作为右面板显示：即使 active 为 false 也保持可见（wrapper 已用 .term-split-shown 控制显隐） */
  splitPane?: boolean;
}) {
  const sessionId = tab.sessionId ?? tab.id;
  const [services, setServices] = useState<ClusterServiceInfo[]>([]);
  const [yarnApps, setYarnApps] = useState<YarnApp[]>([]);
  const [yarnLoading, setYarnLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // 统计图表数据（HDFS 存储与块 / YARN 总资源）
  const [hdfsSum, setHdfsSum] = useState<HdfsSummary | null>(null);
  const [yarnMet, setYarnMet] = useState<YarnMetrics | null>(null);
  const [nnJvm, setNnJvm] = useState<NameNodeJvm | null>(null);
  // 各区域容错状态：集群未启动时静默降级为"未启动"提示，而非顶部红色错误条
  const [svcError, setSvcError] = useState('');
  const [yarnError, setYarnError] = useState('');
  const [hdfsError, setHdfsError] = useState('');
  const [hdfsSumError, setHdfsSumError] = useState('');
  const [yarnMetError, setYarnMetError] = useState('');
  const [nnJvmError, setNnJvmError] = useState('');
  // DataNode 明细（卷/磁盘健康）与 NodeManager 明细
  const [hdfsNodes, setHdfsNodes] = useState<HdfsNodes | null>(null);
  const [yarnNodes, setYarnNodes] = useState<YarnNode[] | null>(null);
  const [yarnNodesError, setYarnNodesError] = useState('');
  // 正在执行的服务操作（key -> action），行内显示"启动中…/停止中…/重启中…"
  const [operating, setOperating] = useState<Record<string, ServiceAction>>({});
  // 服务操作结果提示（成功/失败）
  const [notice, setNotice] = useState<{ type: 'ok' | 'error'; msg: string } | null>(null);
  const noticeTimerRef = useRef<number | null>(null);
  // 请求序号：并发请求时丢弃旧响应，防止旧数据覆盖新数据（竞态闪烁）
  const svcSeqRef = useRef(0);
  const hdfsSeqRef = useRef(0);
  // HDFS 分页（大目录避免一次性渲染万级 DOM）
  const [hdfsPage, setHdfsPage] = useState(0);
  const HDFS_PAGE_SIZE = 100;
  const [busyKeys, setBusyKeys] = useState<Record<string, boolean>>({});
  const [confirm, setConfirm] = useState<ConfirmReq | null>(null);
  const [log, setLog] = useState<LogReq | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(false);
  // HDFS 文件浏览：当前路径 / 条目列表 / 输入框
  const [hdfsPath, setHdfsPath] = useState('/');
  const [hdfsEntries, setHdfsEntries] = useState<HdfsEntry[]>([]);
  const [hdfsLoading, setHdfsLoading] = useState(false);
  const [hdfsInput, setHdfsInput] = useState('');
  // 自动刷新定时器
  const timerRef = useRef<number | null>(null);

  const withBusy = useCallback(
    async (key: string, fn: () => Promise<string>, onDone: (msg: string) => void) => {
      setBusyKeys((b) => ({ ...b, [key]: true }));
      try {
        const msg = await fn();
        onDone(msg);
        return true;
      } catch (e) {
        onDone(String(e));
        return false;
      } finally {
        setBusyKeys((b) => ({ ...b, [key]: false }));
      }
    },
    [],
  );

  // 加载全部数据（首次 / 手动刷新）。
  // 集群未启动时服务检测本身不会失败（返回 stopped），但 YARN/HDFS 命令会报错——
  // 用 allSettled 分别处理，各区域独立降级为"未启动"提示，不弹出顶部错误条。
  const loadAll = useCallback(async () => {
    const seq = ++svcSeqRef.current;
    setLoading(true);
    setError('');
    try {
      const [svc, apps, hSum, yMet, jvm, dn, yNodes] = await Promise.allSettled([
        clusterListServices(sessionId),
        clusterYarnApps(sessionId),
        clusterHdfsSummary(sessionId),
        clusterYarnMetrics(sessionId),
        clusterNameNodeJvm(sessionId),
        clusterHdfsNodes(sessionId),
        clusterYarnNodes(sessionId),
      ]);
      // 已有更新的请求发出，丢弃本次过期结果（收尾交给那一次请求）
      if (seq !== svcSeqRef.current) return;
      if (svc.status === 'fulfilled') {
        setServices(svc.value);
        setSvcError('');
      } else {
        setSvcError(String(svc.reason));
      }
      if (apps.status === 'fulfilled') {
        setYarnApps(apps.value);
        setYarnError('');
      } else {
        setYarnApps([]);
        setYarnError(String(apps.reason));
      }
      if (hSum.status === 'fulfilled') {
        setHdfsSum(hSum.value);
        setHdfsSumError('');
      } else {
        setHdfsSum(null);
        setHdfsSumError(String(hSum.reason));
      }
      if (yMet.status === 'fulfilled') {
        setYarnMet(yMet.value);
        setYarnMetError('');
      } else {
        setYarnMet(null);
        setYarnMetError(String(yMet.reason));
      }
      if (jvm.status === 'fulfilled') {
        setNnJvm(jvm.value);
        setNnJvmError('');
      } else {
        setNnJvm(null);
        setNnJvmError(String(jvm.reason));
      }
      // DataNode 明细不再单独显示（健康摘要仍用它做安全模式/掉线/元数据目录告警）
      if (dn.status === 'fulfilled') {
        setHdfsNodes(dn.value);
      } else {
        setHdfsNodes(null);
      }
      if (yNodes.status === 'fulfilled') {
        setYarnNodes(yNodes.value);
        setYarnNodesError('');
      } else {
        setYarnNodes(null);
        setYarnNodesError(String(yNodes.reason));
      }
    } finally {
      // 只有自己仍是最新请求时才解除加载态。
      // 否则：手动刷新（loadAll）被 15s 自动刷新（loadLight）取代时，上面那句
      // return 会跳过收尾，loading 永远停在 true → 刷新按钮变成永久禁用的
      // "加载中…"（这是"手动刷新失灵"的根因）。
      if (seq === svcSeqRef.current) setLoading(false);
    }
  }, [sessionId]);

  // 自动刷新：服务状态 + YARN + 统计图表（服务检测命令较慢，默认不开启）。
  // 与手动刷新（loadAll）的语义**刻意不同**——这里是**非破坏性**的：
  // 某一路取数失败时保留上一轮的数据，只在该区域记录失败原因，不让一次瞬时抖动
  // （SSH 超时 / JMX 卡顿 / 服务重启中）把图表整体打空。之前的实现在失败分支里
  // setHdfsSum(null)/setYarnMet(null)…（与本注释矛盾），正是"图表时有时无"的来源。
  // 需要"服务停了就把图表清掉"的权威语义时走 loadAll（手动刷新 / 启停后）。
  const loadLight = useCallback(async () => {
    const seq = ++svcSeqRef.current;
    try {
      const [svc, apps, hSum, yMet, jvm, dn, yNodes] = await Promise.allSettled([
        clusterListServices(sessionId),
        clusterYarnApps(sessionId),
        clusterHdfsSummary(sessionId),
        clusterYarnMetrics(sessionId),
        clusterNameNodeJvm(sessionId),
        clusterHdfsNodes(sessionId),
        clusterYarnNodes(sessionId),
      ]);
      // 已有更新的请求发出，丢弃本次过期结果（收尾交给那一次请求）
      if (seq !== svcSeqRef.current) return;
      if (svc.status === 'fulfilled') {
        setServices(svc.value);
        setSvcError('');
      } else {
        setSvcError(String(svc.reason));
      }
      if (apps.status === 'fulfilled') {
        setYarnApps(apps.value);
        setYarnError('');
      } else {
        // 保留旧列表，只提示原因
        setYarnError(String(apps.reason));
      }
      if (hSum.status === 'fulfilled') {
        setHdfsSum(hSum.value);
        setHdfsSumError('');
      } else {
        setHdfsSumError(String(hSum.reason));
      }
      if (yMet.status === 'fulfilled') {
        setYarnMet(yMet.value);
        setYarnMetError('');
      } else {
        setYarnMetError(String(yMet.reason));
      }
      if (jvm.status === 'fulfilled') {
        setNnJvm(jvm.value);
        setNnJvmError('');
      } else {
        setNnJvmError(String(jvm.reason));
      }
      if (dn.status === 'fulfilled') {
        setHdfsNodes(dn.value);
      }
      if (yNodes.status === 'fulfilled') {
        setYarnNodes(yNodes.value);
        setYarnNodesError('');
      } else {
        setYarnNodesError(String(yNodes.reason));
      }
    } finally {
      // 自己是最后一次请求时负责解除加载态（被 loadAll 取代时由 loadAll 收尾）
      if (seq === svcSeqRef.current) setLoading(false);
    }
  }, [sessionId]);

  // 仅刷新 YARN 任务列表（独立刷新按钮）
  const loadYarn = useCallback(async () => {
    setYarnLoading(true);
    try {
      const apps = await clusterYarnApps(sessionId);
      setYarnApps(apps);
      setYarnError('');
    } catch (e) {
      setYarnApps([]);
      setYarnError(String(e));
    } finally {
      setYarnLoading(false);
    }
  }, [sessionId]);

  // 加载 HDFS 目录内容
  const loadHdfs = useCallback(
    async (path: string, force = false) => {
      const seq = ++hdfsSeqRef.current;
      setHdfsLoading(true);
      try {
        const entries = await clusterHdfsList(sessionId, path, force);
        if (seq !== hdfsSeqRef.current) return; // 过期响应丢弃（快速连续切换目录时）
        setHdfsPath(path);
        setHdfsEntries(entries);
        setHdfsPage(0); // 切换目录后回到第一页
        setHdfsInput(path === '/' ? '' : path);
        setHdfsError('');
      } catch (e) {
        if (seq !== hdfsSeqRef.current) return;
        // HDFS 不可用（未启动/未就绪/权限）：区域内显示真实原因，不弹顶部错误条
        setHdfsEntries([]);
        setHdfsPage(0);
        const msg = String(e).trim();
        setHdfsError(msg.length > 60 ? `${msg.slice(0, 57)}…` : (msg || 'HDFS 不可用'));
      } finally {
        if (seq === hdfsSeqRef.current) setHdfsLoading(false);
      }
    },
    [sessionId],
  );

  // 点击目录进入下一级（乐观更新输入框，数据到达后由 loadHdfs 校正）
  const enterDir = (entry: HdfsEntry) => {
    const target = hdfsPath === '/' ? `/${entry.name}` : `${hdfsPath}/${entry.name}`;
    setHdfsInput(target);
    void loadHdfs(target);
  };

  // 返回上一级
  const goUp = () => {
    if (hdfsPath === '/') return;
    const parent = hdfsPath.substring(0, hdfsPath.lastIndexOf('/'));
    void loadHdfs(parent === '' ? '/' : parent);
  };

  // 输入路径跳转：以 '/' 开头直接用，否则拼接当前路径
  const jumpTo = () => {
    const raw = hdfsInput.trim();
    if (!raw) return;
    const target = raw.startsWith('/') ? raw : hdfsPath === '/' ? `/${raw}` : `${hdfsPath}/${raw}`;
    void loadHdfs(target);
  };

  // 手动刷新：服务 + YARN + HDFS 一起重载（启动服务后点刷新即可看到 HDFS 文件）
  const refreshAll = useCallback(() => {
    void loadAll();
    void loadHdfs(hdfsPath, true);
  }, [loadAll, loadHdfs, hdfsPath]);

  // 挂载时加载 + 自动刷新定时器
  useEffect(() => {
    void loadAll();
    void loadHdfs('/');
    return () => {
      if (timerRef.current !== null) {
        window.clearInterval(timerRef.current);
        timerRef.current = null;
      }
      if (noticeTimerRef.current !== null) {
        window.clearTimeout(noticeTimerRef.current);
        noticeTimerRef.current = null;
      }
    };
  }, [loadAll, loadHdfs]);

  // 自动刷新开关：仅在标签激活时轮询——切到后台暂停（不再打 SSH/JMX），
  // 切回前台时立即补刷一次，避免展示长时间未更新的旧数据。
  useEffect(() => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (autoRefresh && active) {
      timerRef.current = window.setInterval(() => void loadLight(), 15000);
    }
    return () => {
      if (timerRef.current !== null) {
        window.clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [autoRefresh, active, loadLight]);

  // 切回前台时立即补刷一次（仅在自动刷新开启时有意义）
  const wasActiveRef = useRef(active);
  useEffect(() => {
    if (active && !wasActiveRef.current && autoRefresh) {
      void loadLight();
    }
    wasActiveRef.current = active;
  }, [active, autoRefresh, loadLight]);

  // 显示操作结果提示（成功后自动消失）
  const showNotice = useCallback((type: 'ok' | 'error', msg: string) => {
    setNotice({ type, msg });
    if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = window.setTimeout(
      () => setNotice(null),
      type === 'ok' ? 6000 : 10000,
    );
  }, []);

  // 服务启停：点击后行内显示"启动中…/停止中…/重启中…"，等待结果返回，
  // 成功 → 用后端重新检测的最新状态更新该行 + 绿色提示；失败 → 红色提示
  const runServiceAction = (svc: ClusterServiceInfo, action: ServiceAction) => {
    const act = actionText(action);
    setConfirm({
      title: `${act}服务`,
      message: `确定要${act} ${svc.name} 吗？${action === 'stop' ? '这将停止该服务及其依赖。' : ''}`,
      busyText: `${act}中…（JVM 类服务首次操作最长约 5 分钟）`,
      run: async () => {
        setOperating((o) => ({ ...o, [svc.key]: action }));
        try {
          const res = await clusterServiceAction(sessionId, svc.key, action);
          // 后端已重新检测该组件状态+端口，直接更新这一行（状态徽章/端口即时变化）
          setServices((prev) => prev.map((s) => (s.key === svc.key ? res.service : s)));
          showNotice('ok', `${res.message}，当前状态：${statusText(res.service.status)}`);
          // 启停/重启后走**权威全量刷新**（loadAll）：取数失败时清空对应图表，
          // 避免"服务已停止、图表却还显示上一轮的旧数据"。周期性的自动刷新
          // 才用非破坏性的 loadLight（瞬时抖动保留旧数据）。
          void loadAll();
          return res.message;
        } catch (e) {
          showNotice('error', `${act}失败：${String(e)}`);
          void loadAll();
          return '';
        } finally {
          setOperating((o) => {
            const next = { ...o };
            delete next[svc.key];
            return next;
          });
        }
      },
    });
  };

  // 查看日志
  const showLog = async (svc: ClusterServiceInfo) => {
    setLog({ key: svc.key, name: svc.name, content: '', loading: true });
    try {
      const content = await clusterServiceLogs(sessionId, svc.key);
      setLog((l) => (l && l.key === svc.key ? { ...l, content, loading: false } : l));
    } catch (e) {
      setLog((l) => (l && l.key === svc.key ? { ...l, content: String(e), loading: false } : l));
    }
  };

  // 打开 Web UI（经 tauri-plugin-opener 用系统默认浏览器打开）
  const openWebUi = async (svc: ClusterServiceInfo) => {
    try {
      const url = await clusterWebUrl(sessionId, svc.key);
      await openUrl(url);
    } catch (e) {
      setError(String(e));
    }
  };

  // 终止 YARN 应用
  const killYarnApp = (app: YarnApp) => {
    setConfirm({
      title: '终止应用',
      message: `确定要终止 YARN 应用 ${app.name}（${app.id}）吗？该操作不可恢复。`,
      busyText: '终止中…',
      run: async () => {
        const ok = await withBusy(`kill:${app.id}`, () => clusterYarnKill(sessionId, app.id), (msg) => {
          setError(msg);
          void loadLight();
        });
        if (ok) {
          setError('');
          void loadLight();
        }
        return ok ? `已终止 ${app.id}` : '';
      },
    });
  };

  // 集群健康告警：由已取到的四个视图聚合，异常时才有内容
  const healthIssues = collectHealthIssues(hdfsSum, hdfsNodes, yarnMet, yarnNodes);

  return (
    <div
      className={`cluster-panel${active || splitPane ? '' : ' inactive'}${splitPane ? ' cluster-stacked' : ''}`}
    >
      {/* 顶栏 */}
      <div className="cluster-toolbar">
        <div className="cluster-title">
          <span className="cluster-title-icon">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="4" width="18" height="7" rx="2" />
              <rect x="3" y="13" width="18" height="7" rx="2" />
              <path d="M7 7.5h.01M7 16.5h.01" strokeLinecap="round" />
            </svg>
          </span>
          集群监控
          <span className="cluster-target">{tab.username}@{tab.host}</span>
        </div>
        <div className="cluster-toolbar-actions">
          <label className="cluster-auto" title="每 15 秒自动刷新服务状态与 YARN 列表">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
            />
            自动刷新
          </label>
          <button className="btn" onClick={() => refreshAll()} disabled={loading}>
            {loading ? '加载中…' : '刷新'}
          </button>
        </div>
      </div>

      {notice && (
        <div className={`cluster-error${notice.type === 'ok' ? ' ok' : ''}`}>{notice.msg}</div>
      )}
      {error && <div className="cluster-error">{error}</div>}

      {/* 集群健康摘要：只在检测到异常时出现（正常时不占视觉噪音） */}
      {healthIssues.length > 0 && (
        <div className="cluster-health">
          <span className="cluster-health-title">集群异常</span>
          {healthIssues.map((it) => (
            <span key={it.text} className={`cluster-health-item ${it.level}`}>
              {it.text}
            </span>
          ))}
        </div>
      )}

      <div className="cluster-body cluster-cols">
        <div className="cluster-col-main">
          {/* 服务区 */}
          <section className="cluster-section">
            <div className="cluster-section-title">服务</div>
            <div className="cluster-service-list">
              {services.length === 0 &&
                SERVICE_KEYS.map((key) => (
                  <div className="cluster-service-row" key={key}>
                    <span className="cluster-svc-name">{key}</span>
                    <span className={`cluster-badge ${svcError ? 'down' : 'checking'}`}>
                      {!svcError && <span className="pulse-dot" />}
                      {svcError ? '检测失败' : '检测中…'}
                    </span>
                    <span className="cluster-svc-ports">—</span>
                    <span className="cluster-svc-actions">
                      <button className="mini-btn ok" disabled>
                        启动
                      </button>
                      <button className="mini-btn" disabled title="查看最新日志">
                        日志
                      </button>
                      <button className="mini-btn" disabled title="打开 Web UI">
                        Web UI
                      </button>
                    </span>
                  </div>
                ))}
              {services.map((svc) => {
                const op = operating[svc.key];
                const busy = loading || !!op;
                return (
                  <div className="cluster-service-row" key={svc.key}>
                    <span className="cluster-svc-name">{svc.name}</span>
                    <span
                      className={`cluster-badge ${op ? 'checking' : statusClass(svc.status)}`}
                      title={svc.error || undefined}
                    >
                      {op && <span className="pulse-dot" />}
                      {op ? `${actionText(op)}中…` : statusText(svc.status)}
                    </span>
                    <span className="cluster-svc-ports" title={svc.ports}>
                      {svc.ports || '—'}
                    </span>
                    <span className="cluster-svc-actions">
                      {svc.status !== 'running' && (
                        <button className="mini-btn ok" disabled={busy} onClick={() => runServiceAction(svc, 'start')}>
                          启动
                        </button>
                      )}
                      {(svc.status === 'running' || svc.status === 'degraded') && (
                        <button className="mini-btn danger" disabled={busy} onClick={() => runServiceAction(svc, 'stop')}>
                          停止
                        </button>
                      )}
                      {(svc.status === 'running' || svc.status === 'degraded') && (
                        <button className="mini-btn" disabled={busy} onClick={() => runServiceAction(svc, 'restart')}>
                          重启
                        </button>
                      )}
                      <button className="mini-btn" disabled={busy} onClick={() => void showLog(svc)} title="查看最新日志">
                        日志
                      </button>
                      <button className="mini-btn" disabled={busy} onClick={() => void openWebUi(svc)} title={`打开 Web UI（端口 ${svc.web_port}）`}>
                        Web UI
                      </button>
                    </span>
                    {/* 仅"非运行中"才展示诊断信息：check_cmd 的 stderr 在服务健康时
                        没有意义（MySQL 的检测命令会把 `systemctl status` 打到 stderr，
                        作为未启动时的线索），展示出来会变成误报的红色告警 */}
                    {svc.error && svc.status !== 'running' && (
                      <span className="cluster-svc-error" title={svc.error}>
                        {svc.error}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </section>

          {/* YARN 区 */}
          <section className="cluster-section">
            <div className="cluster-section-title cluster-section-title-actions">
              <span>YARN</span>
              <button
                className="mini-btn"
                onClick={() => void loadYarn()}
                disabled={yarnLoading}
                title="刷新 YARN 任务列表"
              >
                {yarnLoading ? '刷新中…' : '刷新'}
              </button>
            </div>
            <div className="cluster-table-wrap">
              <table className="cluster-table">
                <thead>
                  <tr>
                    <th>应用 ID</th>
                    <th>名称</th>
                    <th>用户</th>
                    <th>队列</th>
                    <th>状态</th>
                    <th>进度</th>
                    <th className="th-ops">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {yarnApps.length === 0 && (
                    <tr>
                      <td colSpan={7} className="cluster-table-empty">{yarnError ? 'YARN 未启动或不可用' : loading ? '正在加载…' : '暂无 YARN 应用'}</td>
                    </tr>
                  )}
                  {yarnApps.map((app) => (
                    <tr key={app.id}>
                      <td className="mono">{app.id}</td>
                      <td>{app.name}</td>
                      <td>{app.user}</td>
                      <td>{app.queue}</td>
                      <td>
                        <span className={`cluster-badge ${statusClass(app.state.toLowerCase())}`}>{app.state}</span>
                      </td>
                      <td className="mono">{app.progress}</td>
                      <td>
                        {!['FINISHED', 'KILLED', 'FAILED'].includes(app.state.toUpperCase()) && (
                          <button
                            className="mini-btn danger"
                            disabled={!!busyKeys[`kill:${app.id}`]}
                            onClick={() => killYarnApp(app)}
                          >
                            {busyKeys[`kill:${app.id}`] ? '终止中' : '终止'}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {/* HDFS 文件浏览 */}
          <section className="cluster-section">
            <div className="cluster-section-title">HDFS 文件</div>
            <div className="cluster-hdfs-bar">
              <button className="mini-btn" onClick={goUp} disabled={hdfsPath === '/'} title="返回上一级">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M15 6l-6 6 6 6" />
                </svg>
              </button>
              <input
                className="cluster-hdfs-input mono"
                value={hdfsInput}
                placeholder="输入 HDFS 路径后回车（如 /user、/tmp）"
                onChange={(e) => setHdfsInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') jumpTo();
                }}
                spellCheck={false}
              />
              <button className="mini-btn" onClick={jumpTo} disabled={!hdfsInput.trim()} title="跳转到输入路径">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M5 12h14M13 6l6 6-6 6" />
                </svg>
              </button>
              <button
                className="mini-btn"
                onClick={() => void loadHdfs(hdfsPath, true)}
                disabled={hdfsLoading}
                title="刷新当前目录"
              >
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 12a9 9 0 1 1-2.64-6.36L21 8" />
                  <path d="M21 3v5h-5" />
                </svg>
              </button>
              <span className="cluster-hdfs-cwd mono" title="当前目录">{hdfsPath}</span>
            </div>
            <div className={`cluster-table-wrap${hdfsLoading ? ' cluster-loading' : ''}`}>
              <table className="cluster-table">
                <thead>
                  <tr>
                    <th>名称</th>
                    <th>大小</th>
                    <th>副本</th>
                    <th>属主</th>
                    <th>组</th>
                    <th>修改时间</th>
                  </tr>
                </thead>
                <tbody>
                  {hdfsError ? (
                    <tr>
                      <td colSpan={6} className="cluster-table-empty warn">
                        {hdfsError}（启动后点"刷新"查看）
                      </td>
                    </tr>
                  ) : hdfsLoading && hdfsEntries.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="cluster-table-empty">正在加载…</td>
                    </tr>
                  ) : hdfsEntries.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="cluster-table-empty">
                        {hdfsPath === '/' ? '根目录为空' : '目录为空'}
                      </td>
                    </tr>
                  ) : (
                    hdfsEntries
                      .slice(hdfsPage * HDFS_PAGE_SIZE, (hdfsPage + 1) * HDFS_PAGE_SIZE)
                      .map((e, i) => (
                      <tr
                        key={`${e.path}-${i}`}
                        className={e.is_dir ? 'cluster-hdfs-dir' : undefined}
                        onClick={e.is_dir ? () => enterDir(e) : undefined}
                        title={e.is_dir ? `进入 ${e.path}` : e.path}
                      >
                        <td>
                          <span className="cluster-hdfs-name">
                            {e.is_dir ? (
                              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                              </svg>
                            ) : (
                              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                                <path d="M14 2v6h6" />
                              </svg>
                            )}
                            {e.name}
                          </span>
                        </td>
                        <td className="mono" title={e.is_dir ? undefined : e.size}>{e.is_dir ? '—' : formatSize(e.size)}</td>
                        <td className="mono">{e.is_dir ? '—' : e.replication}</td>
                        <td>{e.owner}</td>
                        <td>{e.group}</td>
                        <td className="mono">{e.date}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
            {!hdfsError && hdfsEntries.length > HDFS_PAGE_SIZE && (
              <div className="cluster-hdfs-pager">
                <button
                  className="mini-btn"
                  disabled={hdfsPage === 0}
                  onClick={() => setHdfsPage((p) => Math.max(0, p - 1))}
                >
                  上一页
                </button>
                <span className="mono">
                  第 {hdfsPage + 1} / {Math.ceil(hdfsEntries.length / HDFS_PAGE_SIZE)} 页 · 共{' '}
                  {hdfsEntries.length} 项
                </span>
                <button
                  className="mini-btn"
                  disabled={hdfsPage >= Math.ceil(hdfsEntries.length / HDFS_PAGE_SIZE) - 1}
                  onClick={() => setHdfsPage((p) => p + 1)}
                >
                  下一页
                </button>
              </div>
            )}
          </section>
        </div>

        {/* 右侧统计图表栏 */}
        <div className="cluster-col-side">
          <section className="cluster-chart-card">
            <div className="cluster-chart-title">HDFS 存储与块统计</div>
            {hdfsSum ? <HdfsChart h={hdfsSum} /> : (
              <div className="cluster-chart-empty">
                {hdfsSumError ? (
                  <>
                    HDFS 未启动或不可用
                    <div className="cluster-chart-reason" title={hdfsSumError}>{hdfsSumError}</div>
                  </>
                ) : '加载中…'}
              </div>
            )}
          </section>
          <section className="cluster-chart-card">
            <div className="cluster-chart-title">NameNode JVM</div>
            {nnJvm ? <JvmChart j={nnJvm} /> : (
              <div className="cluster-chart-empty">
                {nnJvmError ? (
                  <>
                    NameNode 未启动或不可用
                    <div className="cluster-chart-reason" title={nnJvmError}>{nnJvmError}</div>
                  </>
                ) : '加载中…'}
              </div>
            )}
          </section>
          <section className="cluster-chart-card">
            <div className="cluster-chart-title">YARN 总资源</div>
            {yarnMet ? <YarnChart m={yarnMet} /> : (
              <div className="cluster-chart-empty">
                {yarnMetError ? (
                  <>
                    YARN 未启动或不可用
                    <div className="cluster-chart-reason" title={yarnMetError}>{yarnMetError}</div>
                  </>
                ) : '加载中…'}
              </div>
            )}
          </section>
          <section className="cluster-chart-card">
            <div className="cluster-chart-title">NodeManager</div>
            {yarnNodes ? <YarnNodeList nodes={yarnNodes} /> : (
              <div className="cluster-chart-empty">
                {yarnNodesError ? (
                  <>
                    NodeManager 信息不可用
                    <div className="cluster-chart-reason" title={yarnNodesError}>{yarnNodesError}</div>
                  </>
                ) : '加载中…'}
              </div>
            )}
          </section>
        </div>
      </div>

      {/* 确认操作模态（拦截点击冒泡：关闭弹窗时不切换分屏焦点） */}
      {confirm && (
        <div
          className="modal-backdrop"
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.target === e.currentTarget && setConfirm(null)}
        >
          <div className="modal confirm-modal">
            <div className="modal-header">
              <span>{confirm.title}</span>
              <button className="icon-btn" onClick={() => setConfirm(null)} title="关闭">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            </div>
            <div className="modal-body">
              <p className="confirm-message">{confirm.message}</p>
            </div>
            <div className="modal-footer">
              <button className="btn ghost" onClick={() => setConfirm(null)}>
                取消
              </button>
              <button
                className="btn primary danger-btn"
                onClick={() => {
                  const req = confirm;
                  setConfirm(null);
                  void req.run();
                }}
              >
                确认
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 日志抽屉（拦截点击冒泡：关闭抽屉时不切换分屏焦点） */}
      {log && (
        <div
          className="cluster-drawer-backdrop"
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.target === e.currentTarget && setLog(null)}
        >
          <div className="cluster-drawer">
            <div className="cluster-drawer-header">
              <span>{log.name} 日志</span>
              <button className="icon-btn" onClick={() => setLog(null)} title="关闭">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            </div>
            <div className="cluster-drawer-body">
              {log.loading ? <div className="empty-state"><div className="spinner small" /><p>加载日志…</p></div> : (
                <pre className="cluster-log">{log.content}</pre>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
