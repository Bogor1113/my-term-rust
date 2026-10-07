import { invoke } from '@tauri-apps/api/core';
import { Channel } from '@tauri-apps/api/core';
import type {
  AiConfig,
  AiMessage,
  ClusterServiceInfo,
  ForwardInfo,
  HdfsEntry,
  HdfsNodes,
  HdfsSummary,
  NameNodeJvm,
  ServiceActionResult,
  SessionSummary,
  SftpEntry,
  TabInfo,
  TransferProgress,
  YarnApp,
  YarnMetrics,
  YarnNode,
} from './types';

/** 后端推送的终端事件（与 Rust 端 TerminalEvent 对应） */
export type TerminalEvent =
  | { type: 'data'; data: string }
  | { type: 'close'; data: { reason: 'eof' | 'close' | 'drop' } };

// ---------- base64 工具 ----------

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// ---------- SSH 终端 ----------

/** 建立 SSH 连接，通过 onEvent 接收服务器输出流 */
export function connectSsh(
  tab: TabInfo,
  cols: number,
  rows: number,
  onEvent: (e: TerminalEvent) => void,
): Promise<void> {
  const channel = new Channel<TerminalEvent>();
  channel.onmessage = onEvent;
  return invoke<void>('connect_ssh', {
    sessionId: tab.id,
    host: tab.host,
    port: tab.port,
    username: tab.username,
    password: tab.password,
    cols,
    rows,
    onData: channel,
  });
}

export function sendInput(sessionId: string, dataBase64: string): Promise<void> {
  return invoke<void>('send_input', { sessionId, data: dataBase64 });
}

export function resizePty(sessionId: string, cols: number, rows: number): Promise<void> {
  return invoke<void>('resize_pty', { sessionId, cols, rows });
}

export function disconnectSsh(sessionId: string): Promise<void> {
  return invoke<void>('disconnect_ssh', { sessionId });
}

export function listSessions(): Promise<SessionSummary[]> {
  return invoke<SessionSummary[]>('list_sessions');
}

/**
 * 告知后端「底部状态条当前正在查看哪个会话」。
 *
 * 只有这里指定的会话会真正采集远程资源数据；其余已连接的会话不再每 3 秒
 * 打一轮 SSH（原先它们的数据没有任何订阅者，纯属空转）。
 * 传 null 表示当前没有需要采集的会话。
 */
export function setMonitorSession(sessionId: string | null): Promise<void> {
  return invoke<void>('set_monitor_session', { sessionId });
}

// ---------- 本地端口转发 ----------

export function forwardAdd(
  sessionId: string,
  localPort: number,
  remoteHost: string,
  remotePort: number,
): Promise<ForwardInfo> {
  return invoke<ForwardInfo>('forward_add', {
    sessionId,
    localPort,
    remoteHost,
    remotePort,
  });
}

export function forwardList(): Promise<ForwardInfo[]> {
  return invoke<ForwardInfo[]>('forward_list');
}

export function forwardRemove(sessionId: string, localPort: number): Promise<void> {
  return invoke<void>('forward_remove', { sessionId, localPort });
}

// ---------- AI 大模型 ----------

/** 流式对话：后端通过事件 ai-chunk-<id> / ai-done-<id> 推送结果 */
export function aiChatStream(
  requestId: string,
  config: AiConfig,
  messages: AiMessage[],
): Promise<void> {
  return invoke<void>('ai_chat_stream', { requestId, config, messages });
}

/** 停止生成：中断一次进行中的流式请求（幂等，请求不存在时静默成功） */
export function aiChatCancel(requestId: string): Promise<void> {
  return invoke<void>('ai_chat_cancel', { requestId });
}

/** 取回某会话最近一段终端输出（去 ANSI），供 AI 分析上下文 */
export function sessionRecentOutput(
  sessionId: string,
  maxChars: number,
): Promise<string> {
  return invoke<string>('session_recent_output', { sessionId, maxChars });
}

// ---------- SFTP ----------

export function sftpHome(sessionId: string): Promise<string> {
  return invoke<string>('sftp_home', { sessionId });
}

export function sftpList(sessionId: string, path: string): Promise<SftpEntry[]> {
  return invoke<SftpEntry[]>('sftp_list', { sessionId, path });
}

export function sftpMkdir(sessionId: string, path: string): Promise<void> {
  return invoke<void>('sftp_mkdir', { sessionId, path });
}

export function sftpRename(
  sessionId: string,
  oldPath: string,
  newPath: string,
): Promise<void> {
  return invoke<void>('sftp_rename', { sessionId, oldPath, newPath });
}

export function sftpRemove(
  sessionId: string,
  path: string,
  recursive = false,
): Promise<void> {
  return invoke<void>('sftp_remove', { sessionId, path, recursive });
}

export function sftpDownload(
  sessionId: string,
  remotePath: string,
  localPath: string,
  onProgress: (p: TransferProgress) => void,
  resume = false,
): Promise<void> {
  const channel = new Channel<TransferProgress>();
  channel.onmessage = onProgress;
  return invoke<void>('sftp_download', {
    sessionId,
    remotePath,
    localPath,
    onProgress: channel,
    resume,
  });
}

export function sftpUpload(
  sessionId: string,
  localPath: string,
  remotePath: string,
  onProgress: (p: TransferProgress) => void,
  resume = false,
): Promise<void> {
  const channel = new Channel<TransferProgress>();
  channel.onmessage = onProgress;
  return invoke<void>('sftp_upload', {
    sessionId,
    localPath,
    remotePath,
    onProgress: channel,
    resume,
  });
}

/** 回复一次传输同名冲突的选择（overwrite/skip/rename/overwrite_all/skip_all/cancel） */
export function sftpResolveConflict(
  requestId: string,
  action: string,
): Promise<void> {
  return invoke<void>('sftp_resolve_conflict', { requestId, action });
}

// ---------- 集群监控（Hadoop 生态服务） ----------

/** 检测目标会话全部 7 个集群服务的状态与端口 */
export function clusterListServices(sessionId: string): Promise<ClusterServiceInfo[]> {
  return invoke<ClusterServiceInfo[]>('cluster_list_services', { sessionId });
}

/** 集群服务启停（action: start/stop/restart），返回操作消息 + 操作后重新检测的服务状态 */
export function clusterServiceAction(
  sessionId: string,
  key: string,
  action: 'start' | 'stop' | 'restart',
): Promise<ServiceActionResult> {
  return invoke<ServiceActionResult>('cluster_service_action', { sessionId, key, action });
}

/** 查看服务最新日志（tail 30 行） */
export function clusterServiceLogs(sessionId: string, key: string): Promise<string> {
  return invoke<string>('cluster_service_logs', { sessionId, key });
}

/** 获取服务 Web UI 地址 */
export function clusterWebUrl(sessionId: string, key: string): Promise<string> {
  return invoke<string>('cluster_web_url', { sessionId, key });
}

/** 列出 YARN 应用 */
export function clusterYarnApps(sessionId: string): Promise<YarnApp[]> {
  return invoke<YarnApp[]>('cluster_yarn_apps', { sessionId });
}

/** 终止 YARN 应用 */
export function clusterYarnKill(sessionId: string, appId: string): Promise<string> {
  return invoke<string>('cluster_yarn_kill', { sessionId, appId });
}

/** 列出 HDFS 指定目录下的条目（force=true 时跳过后端缓存，手动刷新用） */
export function clusterHdfsList(
  sessionId: string,
  path: string,
  force = false,
): Promise<HdfsEntry[]> {
  return invoke<HdfsEntry[]>('cluster_hdfs_list', { sessionId, path, force });
}

/** HDFS 存储与块统计（NameNode JMX） */
export function clusterHdfsSummary(sessionId: string): Promise<HdfsSummary> {
  return invoke<HdfsSummary>('cluster_hdfs_summary', { sessionId });
}

/** YARN 集群总资源（ResourceManager metrics） */
export function clusterYarnMetrics(sessionId: string): Promise<YarnMetrics> {
  return invoke<YarnMetrics>('cluster_yarn_metrics', { sessionId });
}

/** NameNode JVM 统计（JvmMetrics JMX） */
export function clusterNameNodeJvm(sessionId: string): Promise<NameNodeJvm> {
  return invoke<NameNodeJvm>('cluster_namenode_jvm', { sessionId });
}

/** DataNode 明细 + 集群级 HDFS 告警（NameNode JMX NameNodeInfo） */
export function clusterHdfsNodes(sessionId: string): Promise<HdfsNodes> {
  return invoke<HdfsNodes>('cluster_hdfs_nodes', { sessionId });
}

/** NodeManager 明细（RM /ws/v1/cluster/nodes） */
export function clusterYarnNodes(sessionId: string): Promise<YarnNode[]> {
  return invoke<YarnNode[]>('cluster_yarn_nodes', { sessionId });
}


