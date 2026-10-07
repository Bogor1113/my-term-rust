// 同名文件冲突信息
export interface ConflictInfo {
  requestId: string;
  name: string;
  path: string;
}

// 传输进度（文件 / 目录通用）
export interface TransferProgress {
  transferred: number;
  total: number;
  percent: number;
  /** 当前正在传输的文件（目录传输时为相对路径） */
  file: string | null;
  /** 已完成文件数 */
  files: number;
  /** 总文件数 */
  totalFiles: number;
  /** 因同名冲突跳过的文件数 */
  skipped: number;
  /** 存在同名冲突时非空，传输等待前端选择 */
  conflict: ConflictInfo | null;
}

// 系统资源监控
export interface DiskInfo {
  name: string;
  total: number;
  available: number;
  percent: number;
}

export interface SysInfo {
  cpuPercent: number;
  cpuBrand: string;
  memTotal: number;
  memUsed: number;
  memPercent: number;
  netRx: number; // 下行 字节/秒
  netTx: number; // 上行 字节/秒
  disks: DiskInfo[];
}

// SFTP
export interface SftpEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  mtime: number | null;
  perms: string;
}

// 会话
export interface SessionSummary {
  id: string;
  host: string;
  port: number;
  username: string;
  status: 'connected' | 'closed';
}

// 本地端口转发
export interface ForwardInfo {
  sessionId: string;
  host: string;
  localPort: number;
  remoteHost: string;
  remotePort: number;
}

// ---------- AI 大模型 ----------

// 一条对话消息
export interface AiMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

// 模型调用配置（OpenAI 兼容接口）
export interface AiConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
}

// 保存的 AI 模型配置（可多套，存 localStorage）
export interface AiProfile {
  id: string;
  name: string;
  config: AiConfig;
}

// 保存的服务器
export interface SavedHost {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  password: string;
  /** 可选分组名（用于侧栏按组归类；空字符串或缺失表示未分组） */
  group?: string;
}

// 命令片段（快捷命令）
export interface Snippet {
  id: string;
  /** 显示名称 */
  name: string;
  /** 实际发送的命令文本（点击时附带回车执行） */
  command: string;
  /** 可选分组 */
  group?: string;
}

// 一个标签页（会话）的配置
export interface TabInfo {
  id: string;
  /** ssh = 终端会话标签；cluster = 集群监控标签（sessionId 指向目标会话） */
  kind: 'ssh' | 'cluster';
  host: string;
  port: number;
  username: string;
  password: string;
  /** 集群监控标签指向的目标会话 id（ssh 标签无此字段，自身 id 即会话 id） */
  sessionId?: string;
}

// ---------- 集群监控 ----------

export type ClusterServiceStatus = 'running' | 'stopped' | 'degraded' | 'unknown';

export interface ClusterServiceInfo {
  key: string;
  name: string;
  status: ClusterServiceStatus;
  ports: string;
  error: string;
  web_port: number;
}

/** 服务操作结果：操作消息 + 操作后重新检测的最新服务信息 */
export interface ServiceActionResult {
  message: string;
  service: ClusterServiceInfo;
}

export interface YarnApp {
  id: string;
  name: string;
  user: string;
  state: string;
  progress: string;
  queue: string;
}

/** HDFS 目录条目（hdfs dfs -ls 解析结果） */
export interface HdfsEntry {
  name: string;
  path: string;
  is_dir: boolean;
  size: string;
  replication: string;
  owner: string;
  group: string;
  date: string;
}

/** HDFS 存储与块统计（NameNode JMX） */
export interface HdfsSummary {
  capacityTotalGb: number;
  capacityUsedGb: number;
  capacityRemainingGb: number;
  /** 同盘上「非 HDFS」占用：与 capacityUsedGb 相加才等于 `df` 的已用量 */
  capacityUsedNonDfsGb: number;
  totalBlocks: number;
  missingBlocks: number;
  underReplicatedBlocks: number;
  corruptBlocks: number;
  pendingDeletionBlocks: number;
  liveDatanodes: number;
  deadDatanodes: number;
  totalFiles: number;
  /** 当前并发读写（xceiver）数 */
  totalLoad: number;
  /** 距上次 editlog checkpoint 的事务数 */
  transactionsSinceLastCheckpoint: number;
  /** 上次 checkpoint 时间（epoch ms；0 = 未知） */
  lastCheckpointTimeMs: number;
}

/** 单个 DataNode 状态（NameNode JMX NameNodeInfo.LiveNodes） */
export interface DataNodeStat {
  id: string;
  infoAddr: string;
  location: string;
  adminState: string;
  version: string;
  used: number;
  nonDfsUsed: number;
  remaining: number;
  capacity: number;
  numBlocks: number;
  blockPoolUsedPercent: number;
  /** 卷故障数（> 0 = 有磁盘卷不可用） */
  volFails: number;
  lastBlockReportSecs: number;
}

/** HDFS 节点视图（DataNode 明细 + 集群级告警） */
export interface HdfsNodes {
  nodes: DataNodeStat[];
  deadNodes: number;
  safemode: boolean;
  corruptFiles: number;
  nnStartedMs: number;
  /** 正常的 NameNode 元数据目录数 */
  activeDirs: number;
  /** 故障的元数据目录名（非空 = NameNode 元数据目录坏了） */
  failedDirs: string[];
  /** 尚未 checkpoint 的事务数（JournalTransactionInfo 两个 TxId 之差） */
  checkpointGap: number;
}

/** 单个 NodeManager 状态（RM /ws/v1/cluster/nodes） */
export interface YarnNode {
  id: string;
  state: string;
  /** 空字符串 = 健康；非空为 NodeManager 给出的具体原因 */
  healthReport: string;
  nodeHttpAddress: string;
  rack: string;
  usedMemoryMb: number;
  availableMemoryMb: number;
  usedVcores: number;
  availableVcores: number;
  numContainers: number;
  /** NodeManager 上报的物理内存利用率（%） */
  memUtilization: number;
  lastHealthUpdateMs: number;
}

/** YARN 集群总资源（ResourceManager metrics） */
export interface YarnMetrics {
  totalMb: number;
  allocatedMb: number;
  availableMb: number;
  totalVcores: number;
  allocatedVcores: number;
  availableVcores: number;
  activeNodes: number;
  lostNodes: number;
  /** RM 判定不可用的节点数（> 0 强告警，常见原因：磁盘满） */
  unhealthyNodes: number;
  runningApps: number;
  pendingApps: number;
  /** 累计计数（自 RM 启动）：提交 / 完成 / 失败 / 终止 */
  appsSubmitted: number;
  appsCompleted: number;
  appsFailed: number;
  appsKilled: number;
  containersAllocated: number;
  /** 集群内存利用率（%） */
  utilizedMbPercent: number;
}

/** NameNode JVM 统计（JvmMetrics JMX） */
export interface NameNodeJvm {
  heapUsedMb: number;
  heapCommittedMb: number;
  heapMaxMb: number;
  gcCount: number;
  gcTimeMs: number;
  threads: number;
}
