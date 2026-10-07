//! 集群监控：Hadoop 生态服务（HDFS/YARN/Hive/DolphinScheduler/MySQL/Spark）的
//! 状态检测、启停、端口、日志与 YARN 应用/节点查询。
//! 移植自独立的 cluster-control-center 项目，适配本项目的多会话架构：
//! 所有命令接收 session_id，通过该会话的 SSH 句柄执行命令（不复用其单连接模型）。
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::AppState;

// ---------- 数据结构 ----------

/// 服务运行状态。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum ClusterServiceStatus {
    #[serde(rename = "running")]
    Running,
    #[serde(rename = "stopped")]
    Stopped,
    #[serde(rename = "degraded")]
    Degraded,
    #[serde(rename = "unknown")]
    Unknown,
}

/// 服务信息（返回前端）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClusterServiceInfo {
    pub key: String,
    pub name: String,
    pub status: ClusterServiceStatus,
    pub ports: String,
    pub error: String,
    pub web_port: u16,
}

/// 服务操作结果：操作消息 + 操作后重新检测的最新服务信息。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServiceActionResult {
    pub message: String,
    pub service: ClusterServiceInfo,
}

/// YARN 应用
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct YarnApp {
    pub id: String,
    pub name: String,
    pub user: String,
    pub state: String,
    pub progress: String,
    pub queue: String,
}

// ---------- 服务配置 ----------

/// 单个服务的检测 / 启停 / 端口命令配置
struct ServiceConfig {
    key: &'static str,
    name: &'static str,
    /// Web UI 访问端口（明确指定，用户环境实际值）
    web_port: u16,
    /// Web UI 子路径（如 DolphinScheduler 的 /dolphinscheduler/ui/login；多数服务为空）
    web_path: &'static str,
    check_cmd: String,
    start_cmd: String,
    stop_cmd: String,
    /// 原子重启命令（如 systemctl restart）；为 None 时重启 = stop + start
    restart_cmd: Option<String>,
    port_cmd: String,
}

/// 命令前缀：显式注入 PATH（含 hadoop/spark/dolphin 的 bin 与系统 sbin）。
/// 不再 source /etc/profile——集群脚本自身会加载各自的 *-env.sh，避免 source profile
/// 的慢初始化（nvm/conda 等）会让每一次 SSH 命令都白白拖慢数百毫秒~数秒。
/// 保留原 $PATH 兜底（可能含自定义 JAVA_HOME 相关路径）。
const SOURCE: &str =
    "export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/opt/hadoop3/bin:/opt/hadoop3/sbin:/opt/spark2/bin:/opt/spark2/sbin:/opt/dolphinscheduler/bin:$PATH; ";

/// 生成端口检测命令：pgrep 拿 pid 后 ss -tlnp 反查监听端口。
/// 兼容旧版 ss（`users:(("java",1234,26))` 无 pid= 前缀）与仅有 netstat 的系统。
fn port_cmd(pattern: &str) -> String {
    format!(
        "{}pids=$(pgrep -f '{}' 2>/dev/null); [ -z \"$pids\" ] && echo \"\" || for pid in $pids; do (ss -tlnp 2>/dev/null | grep -E \"(pid=|,)$pid[,)]\" || netstat -tlnp 2>/dev/null | grep -E \"(^|[ ,/])$pid/\") | grep -oP ':\\K\\d+' ; done | sort -u | tr '\\n' ',' | sed 's/,$//'",
        SOURCE, pattern
    )
}

/// 明确保留的「高位真实端口」白名单。
///
/// 背景：Linux 的临时端口范围（`net.ipv4.ip_local_port_range` 默认 32768-60999）
/// 与 IANA 注册端口段有重叠，纯按数值区间过滤会误伤**真实的服务端口**。
/// 例：MySQL 的 X Protocol 固定用 33060（实测本环境确实在监听），它 ≥32768，
/// 若只按区间过滤就会被当成随机端口丢掉。
/// 因此这里显式列出「虽然高位、但确实是服务端口」的少数几个。
const WELL_KNOWN_HIGH_PORTS: [u32; 1] = [
    33060, // MySQL X Protocol（mysqlx）
];

/// 过滤端口列表，丢掉**运行时随机端口**。
///
/// 起因：`port_cmd` 抓的是「该进程的全部监听端口」，其中会混进 JVM 随机端口。
/// 实测用户环境：HDFS 行出现 `44841`（外部探测不可达的随机端口），
/// YARN 行出现 `42909` —— 后者是 Hadoop 的 NodeManager 容器管理端口，
/// `yarn.nodemanager.address` 默认就是 `0.0.0.0:0`（端口 0 = 每次启动随机分配），
/// 属于**设计使然**，不是服务对外端口。显示出来只会让人误判"端口写错了"。
///
/// 规则：保留 `< 32768` 的端口（含 13562 shuffle、8040 localizer 等真实端口），
/// 以及白名单里的高位真实端口；其余 ≥32768 的一律视为随机端口丢弃。
fn filter_meaningful_ports(raw: &str) -> String {
    raw.split(',')
        .filter_map(|s| s.trim().parse::<u32>().ok())
        .filter(|p| {
            *p > 0 && (*p < 32768 || WELL_KNOWN_HIGH_PORTS.contains(p))
        })
        .map(|p| p.to_string())
        .collect::<Vec<_>>()
        .join(", ")
}

/// 全部 7 个服务定义。
fn get_service_configs() -> Vec<ServiceConfig> {
    vec![
        ServiceConfig {
            key: "HDFS",
            name: "HDFS",
            web_port: 9870,
            web_path: "",
            // 精确检测：完整 Java 主类名匹配，不模糊匹配——不会误中 SecondaryNameNode
            // 或任意含 "NameNode" 字样的进程。[o] 字符类防止匹配到检测命令自身。
            check_cmd: format!(
                "{}nn=$(pgrep -f '[o]rg.apache.hadoop.hdfs.server.namenode.NameNode' | head -1); [ -n \"$nn\" ] && echo -n 'namenode:alive ' || echo -n 'namenode:dead '; echo \"datanode:$(pgrep -f '[o]rg.apache.hadoop.hdfs.server.datanode.DataNode' | wc -l)\"",
                SOURCE
            ),
            start_cmd: format!("{}cd /opt/hadoop3 && sbin/start-dfs.sh", SOURCE),
            // stop-dfs.sh 停 NameNode/DataNode；JVM 优雅关闭可能较慢，追加 SIGTERM 兜底
            //（优雅信号不丢元数据；进程已停时 xargs -r 无操作）
            stop_cmd: format!("{}cd /opt/hadoop3 && sbin/stop-dfs.sh; sleep 2; pgrep -f '[o]rg.apache.hadoop.hdfs.server.namenode.NameNode|[o]rg.apache.hadoop.hdfs.server.datanode.DataNode' | xargs -r kill 2>/dev/null", SOURCE),
            restart_cmd: None,
            port_cmd: port_cmd("[o]rg.apache.hadoop.hdfs.server.namenode.NameNode|[o]rg.apache.hadoop.hdfs.server.datanode.DataNode"),
        },
        ServiceConfig {
            key: "YARN",
            name: "YARN",
            web_port: 8088,
            web_path: "",
            // 精确检测：完整 Java 主类名匹配 ResourceManager/NodeManager（不模糊匹配）。
            check_cmd: format!(
                "{}rm=$(pgrep -f '[o]rg.apache.hadoop.yarn.server.resourcemanager.ResourceManager' | head -1); [ -n \"$rm\" ] && echo -n 'rm:alive ' || echo -n 'rm:dead '; echo \"nm:$(pgrep -f '[o]rg.apache.hadoop.yarn.server.nodemanager.NodeManager' | wc -l)\"",
                SOURCE
            ),
            start_cmd: format!("{}cd /opt/hadoop3 && sbin/start-yarn.sh", SOURCE),
            stop_cmd: format!("{}cd /opt/hadoop3 && sbin/stop-yarn.sh; sleep 2; pgrep -f '[o]rg.apache.hadoop.yarn.server.resourcemanager.ResourceManager|[o]rg.apache.hadoop.yarn.server.nodemanager.NodeManager' | xargs -r kill 2>/dev/null", SOURCE),
            restart_cmd: None,
            port_cmd: port_cmd("[o]rg.apache.hadoop.yarn.server.resourcemanager.ResourceManager|[o]rg.apache.hadoop.yarn.server.nodemanager.NodeManager"),
        },
        ServiceConfig {
            key: "Hive",
            name: "Hive",
            web_port: 10002,
            web_path: "",
            // 精确匹配完整 Java 主类 + 端口监听双重确认（HiveMetaStore:9083 / HiveServer2:10000），
            // 避免其他命令行含 "hive" 字样的进程导致误报运行中
            check_cmd: "pgrep -f '[o]rg.apache.hadoop.hive.metastore.HiveMetaStore' >/dev/null 2>&1 && ss -tln 2>/dev/null | grep -q ':9083 ' && echo 'metastore:alive' || echo 'metastore:dead'; pgrep -f '[o]rg.apache.hive.service.server.HiveServer2' >/dev/null 2>&1 && ss -tln 2>/dev/null | grep -q ':10000 ' && echo 'hiveserver2:alive' || echo 'hiveserver2:dead'".to_string(),
            // </dev/null 断开 stdin：SSH exec 通道关闭时后台 JVM 不因收到 EOF 异常退出。
            start_cmd: format!(
                "{}nohup /opt/hive3/bin/hive --service metastore </dev/null > /tmp/hive-metastore.log 2>&1 & sleep 2; nohup /opt/hive3/bin/hive --service hiveserver2 </dev/null > /tmp/hive-hiveserver2.log 2>&1 &",
                SOURCE
            ),
            stop_cmd: "pgrep -f '[o]rg.apache.hadoop.hive.metastore.HiveMetaStore|[o]rg.apache.hive.service.server.HiveServer2' | xargs -r kill".to_string(),
            restart_cmd: None,
            port_cmd: port_cmd("[o]rg.apache.hadoop.hive.metastore.HiveMetaStore|[o]rg.apache.hive.service.server.HiveServer2"),
        },
        ServiceConfig {
            key: "DolphinScheduler",
            name: "DolphinScheduler",
            web_port: 12345,
            web_path: "/dolphinscheduler/ui/login",
            // 精确匹配用户环境实际主类 org.apache.dolphinscheduler.StandaloneServer
            //（另兼容 jar 打包名 dolphinscheduler-standalone-server）。
            // 运行中 = 进程存在 AND 12345 端口（API server）监听——只有 API 就绪才算启动成功
            check_cmd: "p=$(pgrep -f '[o]rg.apache.dolphinscheduler.StandaloneServer|dolphinscheduler-standalone-server' | head -1); if [ -n \"$p\" ] && ss -tln 2>/dev/null | grep -q ':12345 '; then echo 'running'; else echo 'stopped'; fi; pgrep -f '[o]rg.apache.dolphinscheduler.StandaloneServer|dolphinscheduler-standalone-server' | wc -l".to_string(),
            // 借鉴 offline-warehouse 脚本：nohup + & 后台启动，shell 立即退出、SSH exec
            // 通道随之关闭立即返回；就绪与否交给后续 wait_status 轮询 12345 端口判定。
            // 原先前台 exec dolphinscheduler-daemon.sh start，standalone 模式下 daemon.sh
            // 偶发前台等待 JVM 初始化，exec 一直挂到 60s 超时，表现为"启动卡死"。
            start_cmd: format!("{}cd /opt/dolphinscheduler && nohup /opt/dolphinscheduler/bin/dolphinscheduler-daemon.sh start standalone-server >> /tmp/dolphinscheduler-standalone.log 2>&1 &", SOURCE),
            // 借鉴脚本：daemon.sh stop 后 sleep 5 给 JVM 优雅关闭窗口；残留进程由
            // stop_kill_cmd 用 kill -9 强杀（Dolphin standalone 内嵌 zk + 多组件，
            // SIGTERM 优雅关闭可能极慢甚至卡死）。
            stop_cmd: format!("{}bash /opt/dolphinscheduler/bin/dolphinscheduler-daemon.sh stop standalone-server; sleep 5", SOURCE),
            restart_cmd: None,
            port_cmd: port_cmd("[o]rg.apache.dolphinscheduler.StandaloneServer|dolphinscheduler-standalone-server"),
        },
        ServiceConfig {
            key: "MySQL",
            name: "MySQL",
            web_port: 3306,
            web_path: "",
            // pgrep -x mysqld：精确匹配进程名（不用 -f 模糊匹配 cmdline），
            // 不会误中 mariadbd/含 mysqld 字样的其他进程。
            check_cmd: "pgrep -x mysqld > /dev/null 2>&1 && echo 'running' || echo 'stopped'; systemctl status mysql 2>/dev/null | head -2 1>&2 || service mysql status 2>/dev/null | head -2 1>&2".to_string(),
            start_cmd: format!("{}sudo systemctl start mysql 2>/dev/null || sudo service mysql start 2>/dev/null; pgrep -x mysqld > /dev/null 2>&1 && echo 'running' || echo 'stopped'", SOURCE),
            stop_cmd: format!("{}sudo systemctl stop mysql 2>/dev/null || sudo service mysql stop 2>/dev/null; pgrep -x mysqld > /dev/null 2>&1 && echo 'running' || echo 'stopped'", SOURCE),
            // MySQL 支持原子重启（systemctl restart 同步完成，无需 stop 再 start 两步）。
            restart_cmd: Some(format!("{}sudo systemctl restart mysql 2>/dev/null || sudo service mysql restart 2>/dev/null; pgrep -x mysqld > /dev/null 2>&1 && echo 'running' || echo 'stopped'", SOURCE)),
            port_cmd: port_cmd("[m]ysqld"),
        },
        ServiceConfig {
            key: "SparkMaster",
            name: "Spark Master",
            web_port: 8080,
            web_path: "",
            check_cmd: "pgrep -f '[o]rg.apache.spark.deploy.master.Master' > /dev/null 2>&1 && echo 'running' || echo 'stopped'; pgrep -f '[o]rg.apache.spark.deploy.master.Master' | wc -l".to_string(),
            // start-all.sh 一键启动 master + workers（用户环境实际命令；脚本内部
            // 会自推断 SPARK_HOME，无需环境变量）。
            start_cmd: format!("{}cd /opt/spark2 && sbin/start-all.sh", SOURCE),
            stop_cmd: format!("{}cd /opt/spark2 && sbin/stop-all.sh", SOURCE),
            restart_cmd: None,
            port_cmd: port_cmd("[o]rg.apache.spark.deploy.master.Master"),
        },
        ServiceConfig {
            key: "SparkWorker",
            name: "Spark Worker",
            web_port: 8081,
            web_path: "",
            check_cmd: "pgrep -f '[o]rg.apache.spark.deploy.worker.Worker' > /dev/null 2>&1 && echo 'running' || echo 'stopped'; pgrep -f '[o]rg.apache.spark.deploy.worker.Worker' | wc -l".to_string(),
            // start-all.sh 一键启动 master + workers（与 SparkMaster 一致，启动即全部启动）
            start_cmd: format!("{}cd /opt/spark2 && sbin/start-all.sh", SOURCE),
            stop_cmd: format!("{}cd /opt/spark2 && sbin/stop-all.sh", SOURCE),
            restart_cmd: None,
            port_cmd: port_cmd("[o]rg.apache.spark.deploy.worker.Worker"),
        },
    ]
}

// ---------- 执行辅助 ----------

/// 在远程服务器上执行命令并返回 (stdout, stderr, exit_code)。
/// 锁内仅开通道 + exec，锁外循环收集输出（与 system.rs 的 exec_remote 一致）。
/// 整体带超时：服务启停可能耗时较长（最长 60s），避免命令挂死阻塞调用方。
async fn exec_with_timeout(
    handle_arc: &Arc<tokio::sync::Mutex<russh::client::Handle<crate::ssh::Client>>>,
    cmd: &str,
    timeout_secs: u64,
) -> Result<(String, String, i32), String> {
    use russh::ChannelMsg;

    // 打开通道可能因瞬时并发冲突/服务端限制失败：重试 3 次（递增间隔），
    // 避免"打开通道失败"直接中断操作
    let mut channel = None;
    for attempt in 0..3u32 {
        let handle = handle_arc.lock().await;
        match handle.channel_open_session().await {
            Ok(chan) => {
                channel = Some(chan);
                break;
            }
            Err(e) => {
                drop(handle); // 释放锁再等待，避免长时间持有
                if attempt == 2 {
                    return Err(format!("打开通道失败：{e}"));
                }
                tokio::time::sleep(Duration::from_millis(300 * (attempt + 1) as u64)).await;
            }
        }
    }
    let mut channel = channel.expect("channel retry loop always sets");
    channel
        .exec(true, cmd.as_bytes())
        .await
        .map_err(|e| format!("执行命令失败：{e}"))?;

    let inner = async {
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        let mut exit_code = -1;
        loop {
            match channel.wait().await {
                Some(ChannelMsg::Data { data }) => stdout.extend_from_slice(&data),
                Some(ChannelMsg::ExtendedData { data, ext: _ }) => stderr.extend_from_slice(&data),
                Some(ChannelMsg::ExitStatus { exit_status }) => exit_code = exit_status as i32,
                Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => break,
                Some(_) => {}
            }
        }
        (stdout, stderr, exit_code)
    };

    let (stdout, stderr, exit_code) =
        tokio::time::timeout(Duration::from_secs(timeout_secs), inner)
            .await
            .map_err(|_| "命令执行超时".to_string())?;

    Ok((
        String::from_utf8_lossy(&stdout).into_owned(),
        String::from_utf8_lossy(&stderr).into_owned(),
        exit_code,
    ))
}

/// 从会话表取出连接句柄与主机名（克隆后立即释放全局 sessions 锁，
/// 网络操作在锁外进行，避免阻塞 send_input / resize / SFTP 等命令）
async fn get_conn(
    app: &AppHandle,
    session_id: &str,
) -> Result<(Arc<tokio::sync::Mutex<russh::client::Handle<crate::ssh::Client>>>, String), String> {
    let state = app.state::<AppState>();
    let sessions = state.sessions.lock().await;
    let conn = sessions
        .get(session_id)
        .ok_or_else(|| "会话不存在".to_string())?;
    Ok((conn.handle.clone(), conn.host.clone()))
}

// ---------- 服务管理器 ----------

/// 单个会话的 WebHDFS 探针状态（按会话隔离，避免多台主机的冷却 / 端点互相污染）
#[derive(Clone, Copy)]
struct WebHdfsProbe {
    /// WebHDFS 可用性：失败一次即置 false 进入冷却，冷却期间（30s）内直接走
    /// hdfs 命令避免白等超时；冷却结束自动重新探测（不会永久禁用）。
    ok: bool,
    /// 上次 WebHDFS 探测失败的时间（epoch 秒），用于计算冷却期
    fail_ts: u64,
    /// 本机直连（不经 SSH）整体失败的时刻（epoch 秒）：直连失败说明本地网络到集群
    /// HTTP 端口不通（如防火墙），冷却 5 分钟内直接跳过直连走 SSH 隧道，避免每击白等超时。
    direct_fail_ts: u64,
}

impl Default for WebHdfsProbe {
    fn default() -> Self {
        Self {
            ok: true,
            fail_ts: 0,
            direct_fail_ts: 0,
        }
    }
}

/// 集群服务状态缓存（每次检测写入，避免前端重复请求时反复跑 SSH）。
/// 所有缓存均按 session_id 隔离：不同集群监控标签（不同主机）互不覆盖。
pub struct ClusterManager {
    /// 键为 "session_id::服务名"
    status_cache: tokio::sync::Mutex<HashMap<String, ClusterServiceStatus>>,
    error_cache: tokio::sync::Mutex<HashMap<String, String>>,
    port_cache: tokio::sync::Mutex<HashMap<String, String>>,
    /// 每会话的 WebHDFS 探针状态
    probe: std::sync::Mutex<HashMap<String, WebHdfsProbe>>,
    /// 每会话探测到的 WebHDFS 端点 (host, port)：首次成功后缓存，后续请求直接单端点访问。
    /// host 优先用 `hdfs getconf -namenodeHttpAddress` 返回的真实主机名（NameNode 可能
    /// 只绑定 LAN IP 而非回环），其次 localhost。
    webhdfs_endpoint: std::sync::Mutex<HashMap<String, (String, u16)>>,
    /// 每会话的 HDFS 用户（WebHDFS user.name 参数）：whoami 仅查一次后缓存。
    hdfs_user: std::sync::Mutex<HashMap<String, String>>,
    /// HDFS 目录列表缓存：key = (session_id, path) → (缓存时刻, 条目)。
    /// 目录内容短时间内基本不变，缓存让返回上一级 / 重进目录瞬时响应，
    /// 避免每次点击都启动 hdfs 客户端 JVM（冷启动 5~10s）。
    hdfs_cache: std::sync::Mutex<HashMap<(String, String), (u64, Vec<HdfsEntry>)>>,
    /// 并发去重表：同一 (session_id, path) 的并发请求共享一次底层查询，
    /// 防止快速连点目录时同时启动多个 hdfs JVM / 重复 WebHDFS 请求。
    /// OnceCell 初始化完成后对应记录会被移除，新请求改走缓存。
    /// 查询失败不写入（保持未初始化），下次请求自动重试。
    hdfs_inflight: std::sync::Mutex<HashMap<(String, String), Arc<tokio::sync::OnceCell<Vec<HdfsEntry>>>>>,
}

/// HDFS 目录列表缓存有效期（秒）。
const HDFS_CACHE_TTL_SECS: u64 = 20;

/// 当前 epoch 秒。
fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

impl ClusterManager {
    pub fn new() -> Self {
        Self {
            status_cache: tokio::sync::Mutex::new(HashMap::new()),
            error_cache: tokio::sync::Mutex::new(HashMap::new()),
            port_cache: tokio::sync::Mutex::new(HashMap::new()),
            probe: std::sync::Mutex::new(HashMap::new()),
            webhdfs_endpoint: std::sync::Mutex::new(HashMap::new()),
            hdfs_user: std::sync::Mutex::new(HashMap::new()),
            hdfs_cache: std::sync::Mutex::new(HashMap::new()),
            hdfs_inflight: std::sync::Mutex::new(HashMap::new()),
        }
    }

    /// 缓存键："session_id::服务名"（按会话隔离，多主机互不覆盖）
    fn ckey(session_id: &str, key: &str) -> String {
        format!("{session_id}::{key}")
    }

    fn probe_get(&self, session_id: &str) -> WebHdfsProbe {
        self.probe
            .lock()
            .unwrap()
            .get(session_id)
            .copied()
            .unwrap_or_default()
    }

    fn probe_update(&self, session_id: &str, f: impl FnOnce(&mut WebHdfsProbe)) {
        let mut m = self.probe.lock().unwrap();
        let p = m.entry(session_id.to_string()).or_default();
        f(p);
    }

    /// 指定会话的本机直连失败时刻（epoch 秒），用于计算 5 分钟冷却期
    fn direct_fail_ts_of(&self, session_id: &str) -> u64 {
        self.probe_get(session_id).direct_fail_ts
    }

    /// 标记本机直连失败：进入 5 分钟冷却，期间直接走 SSH 隧道
    fn set_direct_fail(&self, session_id: &str) {
        self.probe_update(session_id, |p| p.direct_fail_ts = now_secs());
    }

    /// 会话断开时清理该会话的全部集群缓存（含过期 HDFS 目录缓存），
    /// 防止长期运行内存缓慢增长。
    pub async fn cleanup_session(&self, session_id: &str) {
        let prefix = format!("{session_id}::");
        self.status_cache
            .lock()
            .await
            .retain(|k, _| !k.starts_with(&prefix));
        self.error_cache
            .lock()
            .await
            .retain(|k, _| !k.starts_with(&prefix));
        self.port_cache
            .lock()
            .await
            .retain(|k, _| !k.starts_with(&prefix));
        self.probe.lock().unwrap().remove(session_id);
        self.webhdfs_endpoint.lock().unwrap().remove(session_id);
        self.hdfs_user.lock().unwrap().remove(session_id);
        self.hdfs_cache
            .lock()
            .unwrap()
            .retain(|(sid, _), _| sid != session_id);
        self.hdfs_inflight
            .lock()
            .unwrap()
            .retain(|(sid, _), _| sid != session_id);
    }

    fn find_config(key: &str) -> Option<ServiceConfig> {
        get_service_configs().into_iter().find(|c| c.key == key)
    }

    /// 启动等待上限（秒）：JVM 类服务首次启动慢，统一 20s 会误报"启动失败"。
    /// Dolphin standalone 要等 12345 API 端口就绪（内置 zk + 初始化，可能 >60s），
    /// 放宽到 90s；MySQL/Spark 秒级就绪，短上限即可。
    fn start_timeout(key: &str) -> u64 {
        match key {
            "DolphinScheduler" => 90,
            "HDFS" | "YARN" | "Hive" | "SparkMaster" | "SparkWorker" => 45,
            _ => 25,
        }
    }

    /// 停止等待上限（秒）：JVM 优雅关闭（HDFS saveNamespace / Dolphin 多组件退出）
    /// 可能超过 30s，放宽到 45s 避免误报"停止失败"
    fn stop_timeout(key: &str) -> u64 {
        match key {
            "HDFS" | "YARN" | "Hive" | "DolphinScheduler" => 45,
            _ => 30,
        }
    }

    fn parse_status(key: &str, stdout: &str) -> ClusterServiceStatus {
        match key {
            "HDFS" => {
                // check_cmd 输出：namenode:alive|dead datanode:<n>
                let nn = stdout.contains("namenode:alive");
                let dn: u32 = stdout
                    .split("datanode:")
                    .nth(1)
                    .and_then(|s| s.split_whitespace().next())
                    .and_then(|s| s.parse().ok())
                    .unwrap_or(0);
                if nn && dn > 0 {
                    ClusterServiceStatus::Running
                } else if nn {
                    ClusterServiceStatus::Degraded
                } else {
                    ClusterServiceStatus::Stopped
                }
            }
            "YARN" => {
                // check_cmd 输出：rm:alive|dead nm:<n>
                let rm = stdout.contains("rm:alive");
                let nm: u32 = stdout
                    .split("nm:")
                    .nth(1)
                    .and_then(|s| s.split_whitespace().next())
                    .and_then(|s| s.parse().ok())
                    .unwrap_or(0);
                if rm && nm > 0 {
                    ClusterServiceStatus::Running
                } else if rm {
                    ClusterServiceStatus::Degraded
                } else {
                    ClusterServiceStatus::Stopped
                }
            }
            "Hive" => {
                let meta_alive = stdout.contains("metastore:alive");
                let hs2_alive = stdout.contains("hiveserver2:alive");
                if meta_alive && hs2_alive {
                    ClusterServiceStatus::Running
                } else if meta_alive || hs2_alive {
                    ClusterServiceStatus::Degraded
                } else {
                    ClusterServiceStatus::Stopped
                }
            }
            "DolphinScheduler" | "MySQL" | "SparkMaster" | "SparkWorker" => {
                if stdout.contains("running") {
                    ClusterServiceStatus::Running
                } else {
                    ClusterServiceStatus::Stopped
                }
            }
            _ => ClusterServiceStatus::Unknown,
        }
    }

    /// 该服务的 check_cmd 是否已内置端口验证（进程 + 端口在一次检测内完成）。
    /// 是则跳过通用的 detect_ports 双确认——通用端口检测依赖 `ss -tlnp` 显示 pid，
    /// 非 root 用户看不到 pid 会误判"无端口"，导致状态错误降级为"部分运行"。
    fn port_verified_in_cmd(key: &str) -> bool {
        matches!(key, "Hive" | "DolphinScheduler")
    }

    /// 无 pid 依赖的端口监听检测：用 `ss -tln` / `netstat -tln` 按**端口号**匹配。
    ///
    /// 与 detect_ports 的关键区别：后者用 `ss -tlnp` 反查 pid → 端口，需要能看到
    /// 进程 pid；而非 root 用户对**他人进程**看不到 pid（Hadoop/Hive/MySQL 通常以
    /// 专用用户运行），于是 detect_ports 返回空，健康服务被误判为「部分运行」。
    /// 更严重的是 wait_status 永远等不到 Running，启停会一路轮询到超时才收场，
    /// 表现为"状态不对 + 启停很久还报失败"。
    ///
    /// 这里只问「该端口在不在监听」，任何用户都能用。误判风险：端口被别的进程占用
    /// 时会算作在监听——但调用前已确认目标服务进程存活，因此只有"进程活着、它自己的
    /// 端口却没起来"这种真实半启动场景才会降级为部分运行，正是我们想要的语义。
    async fn port_listening(
        handle_arc: &Arc<tokio::sync::Mutex<russh::client::Handle<crate::ssh::Client>>>,
        port: u16,
    ) -> bool {
        // 未声明端口（0）→ 不做该层校验，避免无谓降级
        if port == 0 {
            return true;
        }
        let cmd = format!(
            "{}ss -tln 2>/dev/null | grep -q ':{port} ' || netstat -tln 2>/dev/null | grep -q ':{port} '",
            SOURCE
        );
        matches!(exec_with_timeout(handle_arc, &cmd, 6).await, Ok((_, _, 0)))
    }

    /// 检测单个服务状态并写入缓存
    pub async fn check_status(
        &self,
        session_id: &str,
        handle_arc: &Arc<tokio::sync::Mutex<russh::client::Handle<crate::ssh::Client>>>,
        key: &str,
    ) -> ClusterServiceStatus {
        let cfg = match Self::find_config(key) {
            Some(c) => c,
            None => return ClusterServiceStatus::Unknown,
        };

        let result = exec_with_timeout(handle_arc, &cfg.check_cmd, 8).await;

        match result {
            Ok((stdout, stderr, _rc)) => {
                let mut status = Self::parse_status(key, &stdout);
                // 端口双确认：进程判定为运行中时，再验证该进程实际监听的端口
                //（动态检测，不硬编码）。区分三种情况——
                // ① 检测成功且有端口 → 运行中（缓存端口供展示）
                // ② 检测成功但无端口 → 进程残留/未就绪 → 部分运行
                // ③ 检测失败（超时/瞬时错误）→ 不能断定无端口 → 保持运行中，
                //    避免刷新时状态在"已启动/部分启动"间抖动
                if status == ClusterServiceStatus::Running
                    && !Self::port_verified_in_cmd(key)
                {
                    match self.detect_ports(session_id, handle_arc, key).await {
                        Ok(ports) if ports.is_empty() => {
                            // detect_ports 查不到端口有两种可能：
                            //   ① 进程残留 / 服务没真正就绪（真异常 → 部分运行）
                            //   ② 非 root 用户看不到他人进程 pid（假异常，服务其实健康）
                            // 两者必须区分：否则 ①② 一律降级为"部分运行"，健康服务被
                            // 误报，且 wait_status 永远等不到 Running，启停轮询到超时后
                            // 报"启动失败"。这里用无 pid 依赖的端口复核来区分：
                            // 该服务自己声明的端口在监听 → 仍判定运行中。
                            if !Self::port_listening(handle_arc, cfg.web_port).await {
                                status = ClusterServiceStatus::Degraded;
                            }
                        }
                        _ => {}
                    }
                }
                // 诊断信息只在"非运行中"时有意义：部分 check_cmd（如 MySQL）会主动把
                // `systemctl status` 的前两行重定向到 stderr，作为**未启动时**的诊断线索。
                // 服务健康时这段文本毫无价值，若一并缓存，前端会把它当错误渲染成
                // 红色告警——表现为"MySQL 运行中，行下方却挂着一大块 systemd 输出"。
                let diag = if status == ClusterServiceStatus::Running {
                    String::new()
                } else {
                    stderr.trim().to_string()
                };
                self.status_cache
                    .lock()
                    .await
                    .insert(Self::ckey(session_id, key), status.clone());
                self.error_cache
                    .lock()
                    .await
                    .insert(Self::ckey(session_id, key), diag);
                status
            }
            Err(e) => {
                // 检测本身失败（SSH 抖动 / 命令超时）**绝不能**当作"服务已停止"：
                // 那会把一次网络抖动放大成"整个集群全停了"的假象，是最典型的
                // "状态不对"。这里保留上一次的已知状态（从未检测过则为 Unknown），
                // 只把失败原因记进 error_cache。
                // 注：服务真的停了时 pgrep 会正常返回 'stopped'，走的是 Ok 分支，
                // 因此不存在"该显示停止却被保留"的问题。
                let ckey = Self::ckey(session_id, key);
                let prev = self
                    .status_cache
                    .lock()
                    .await
                    .get(&ckey)
                    .cloned()
                    .unwrap_or(ClusterServiceStatus::Unknown);
                self.error_cache
                    .lock()
                    .await
                    .insert(ckey, format!("检测失败：{e}"));
                prev
            }
        }
    }

    /// 检测服务的监听端口并写入缓存。
    /// Ok(ports)：检测成功（ports 可能为空 = 确实无监听端口）；
    /// Err：检测失败（超时等），调用方不应据此判定"无端口"。
    pub async fn detect_ports(
        &self,
        session_id: &str,
        handle_arc: &Arc<tokio::sync::Mutex<russh::client::Handle<crate::ssh::Client>>>,
        key: &str,
    ) -> Result<String, String> {
        let cfg = match Self::find_config(key) {
            Some(c) => c,
            None => return Err("未知服务".to_string()),
        };

        let ports = match exec_with_timeout(handle_arc, &cfg.port_cmd, 6).await {
            // 过滤掉随机临时端口（详见 filter_meaningful_ports 注释）
            Ok((stdout, _stderr, _rc)) => filter_meaningful_ports(&stdout),
            Err(e) => return Err(format!("端口检测失败: {e}")),
        };

        self.port_cache
            .lock()
            .await
            .insert(Self::ckey(session_id, key), ports.clone());
        Ok(ports)
    }

    /// 轮询等待服务状态变化（每 1s 检查一次，最多 timeout 秒）。
    /// 相比固定 sleep：MySQL/Spark 这类秒级就绪的服务立即返回，
    /// HDFS/YARN/Dolphin 这类启动慢的服务轮询到就绪或超时。
    /// 总耗时 = 实际就绪时间，而非固定等待。
    async fn wait_status(
        &self,
        session_id: &str,
        handle_arc: &Arc<tokio::sync::Mutex<russh::client::Handle<crate::ssh::Client>>>,
        key: &str,
        want: ClusterServiceStatus,
        timeout_secs: u64,
    ) -> ClusterServiceStatus {
        let deadline = std::time::Instant::now() + Duration::from_secs(timeout_secs);
        loop {
            let s = self.check_status(session_id, handle_arc, key).await;
            if s == want || std::time::Instant::now() >= deadline {
                return s;
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    }

    /// 执行启动命令并轮询等待进程就绪（不检查当前状态，供 restart 复用）。
    async fn start_raw(
        &self,
        session_id: &str,
        handle_arc: &Arc<tokio::sync::Mutex<russh::client::Handle<crate::ssh::Client>>>,
        key: &str,
    ) -> Result<String, String> {
        let cfg = Self::find_config(key).ok_or_else(|| format!("未知服务: {}", key))?;

        let result = exec_with_timeout(handle_arc, &cfg.start_cmd, 60).await;

        match result {
            Ok((_stdout, stderr, rc)) => {
                // 轮询等待进程就绪（MySQL 1-2s 即返回；HDFS/YARN/Hive/Dolphin 首次
                // 启动慢，按服务差异化等待，最长 90s，避免误报"启动失败"）。
                let new_status = self
                    .wait_status(
                        session_id,
                        handle_arc,
                        key,
                        ClusterServiceStatus::Running,
                        Self::start_timeout(key),
                    )
                    .await;
                match new_status {
                    ClusterServiceStatus::Running => Ok(format!("{} 启动成功", cfg.name)),
                    ClusterServiceStatus::Degraded => Ok(format!("{} 启动（部分）", cfg.name)),
                    _ => {
                        // 失败诊断：check_status 的 error_cache 对多数服务为空
                        //（pgrep/ss 无 stderr），start 命令真正的错误在 stderr 与
                        // 服务日志里，这里补齐后返回给前端。
                        let err = self
                            .start_failure_diag(handle_arc, key, &stderr, rc)
                            .await;
                        Err(format!("{} 启动失败: {}", cfg.name, err))
                    }
                }
            }
            Err(e) => Err(format!("{} 启动失败: {}", cfg.name, e)),
        }
    }

    /// 启动失败的诊断信息：合并 start 命令 stderr / 退出码，再补该服务最新日志尾部。
    /// cluster_service_logs 是 Tauri 命令（需要 AppHandle），这里在管理器内重跑同款命令。
    async fn start_failure_diag(
        &self,
        handle_arc: &Arc<tokio::sync::Mutex<russh::client::Handle<crate::ssh::Client>>>,
        key: &str,
        stderr: &str,
        rc: i32,
    ) -> String {
        let mut parts: Vec<String> = Vec::new();
        if !stderr.trim().is_empty() {
            parts.push(format!("命令错误: {}", stderr.trim()));
        }
        if rc != 0 {
            parts.push(format!("退出码: {}", rc));
        }
        let (path, pattern) = log_source(key);
        if !path.is_empty() {
            let cmd = format!("ls -t {path}/{pattern} 2>/dev/null | head -1 | xargs -r tail -30 2>/dev/null");
            if let Ok((out, _stderr, _rc)) = exec_with_timeout(handle_arc, &cmd, 6).await {
                let t = out.trim();
                if !t.is_empty() && t != "No logs found" {
                    parts.push(format!("最近日志: {}", t));
                }
            }
        }
        if parts.is_empty() {
            parts.push("无额外诊断输出，请用日志按钮查看或检查服务安装路径".to_string());
        }
        parts.join("；")
    }

    /// 启动服务（带"已运行"预检查）。返回 (成功, 消息)
    pub async fn start(
        &self,
        session_id: &str,
        handle_arc: &Arc<tokio::sync::Mutex<russh::client::Handle<crate::ssh::Client>>>,
        key: &str,
    ) -> Result<String, String> {
        let cfg = Self::find_config(key).ok_or_else(|| format!("未知服务: {}", key))?;

        let current = self.check_status(session_id, handle_arc, key).await;
        if current == ClusterServiceStatus::Running {
            return Ok(format!("{} 已在运行", cfg.name));
        }
        self.start_raw(session_id, handle_arc, key).await
    }

    /// 停止兜底 kill 命令（独立执行）：脚本类 stop 命令可能卡住导致命令链后半段
    /// 不执行，兜底 kill 必须单独发一次——保证进程一定能收到 SIGTERM。
    /// Hive/Spark 的 stop 本身就是 kill（快，不卡）；MySQL 的 systemctl 同步完成，无需兜底。
    fn stop_kill_cmd(key: &str) -> String {
        match key {
            "HDFS" => "pgrep -f '[o]rg.apache.hadoop.hdfs.server.namenode.NameNode|[o]rg.apache.hadoop.hdfs.server.datanode.DataNode' | xargs -r kill 2>/dev/null".to_string(),
            "YARN" => "pgrep -f '[o]rg.apache.hadoop.yarn.server.resourcemanager.ResourceManager|[o]rg.apache.hadoop.yarn.server.nodemanager.NodeManager' | xargs -r kill 2>/dev/null".to_string(),
            // kill -9 强杀残留（对齐 offline-warehouse 脚本 stop_dolphin）：
            // Dolphin standalone 内嵌 zk + 多组件，SIGTERM 优雅关闭不可靠，
            // 强杀干净利落，避免 wait_status 轮询到超时仍报"停止失败"。
            "DolphinScheduler" => "pgrep -f '[o]rg.apache.dolphinscheduler.StandaloneServer|dolphinscheduler-standalone-server' | xargs -r kill -9 2>/dev/null".to_string(),
            // start-all/stop-all 是整体操作：无论从 Master 还是 Worker 行发起，
            // 兜底 kill 都清掉 master + worker 全部，避免停一半
            "SparkMaster" | "SparkWorker" => "pgrep -f '[o]rg.apache.spark.deploy.master.Master|[o]rg.apache.spark.deploy.worker.Worker' | xargs -r kill 2>/dev/null".to_string(),
            _ => String::new(),
        }
    }

    /// 执行停止命令并轮询等待进程退出（不检查当前状态，供 restart 复用）。
    async fn stop_raw(
        &self,
        session_id: &str,
        handle_arc: &Arc<tokio::sync::Mutex<russh::client::Handle<crate::ssh::Client>>>,
        key: &str,
    ) -> Result<String, String> {
        let cfg = Self::find_config(key).ok_or_else(|| format!("未知服务: {}", key))?;

        // 1) 主停止命令：脚本可能卡住，超时 30s 而非 60s（超时后仍有兜底 kill）。
        let result = exec_with_timeout(handle_arc, &cfg.stop_cmd, 30).await;
        let stop_stderr = result
            .as_ref()
            .map(|(_, err, _)| err.trim().to_string())
            .unwrap_or_default();

        // 2) 独立兜底 kill：无论主命令成败都执行（如 daemon.sh 等卡住导致进程残留）
        let kill_cmd = Self::stop_kill_cmd(key);
        if !kill_cmd.is_empty() {
            let _ = exec_with_timeout(handle_arc, &kill_cmd, 10).await;
        }

        // 3) 轮询等待进程退出（JVM 优雅关闭可能超 30s，按服务差异化等待）
        match result {
            Ok(_) => {
                let new_status = self
                    .wait_status(
                        session_id,
                        handle_arc,
                        key,
                        ClusterServiceStatus::Stopped,
                        Self::stop_timeout(key),
                    )
                    .await;
                if new_status == ClusterServiceStatus::Stopped {
                    Ok(format!("{} 停止成功", cfg.name))
                } else {
                    // 附上残留进程诊断与停止命令 stderr，前端可看到真实原因
                    let leftover = self.leftover_procs(handle_arc, key).await;
                    let detail = Self::stop_failure_detail(&leftover, &stop_stderr);
                    Err(format!(
                        "{} 停止失败: 仍检测到运行进程{}",
                        cfg.name, detail
                    ))
                }
            }
            Err(e) => {
                // 主命令超时（如 daemon.sh 卡住），但兜底 kill 已执行——
                // 仍轮询确认一次，进程若已退出则算成功。
                let new_status = self
                    .wait_status(
                        session_id,
                        handle_arc,
                        key,
                        ClusterServiceStatus::Stopped,
                        Self::stop_timeout(key),
                    )
                    .await;
                if new_status == ClusterServiceStatus::Stopped {
                    Ok(format!("{} 停止成功", cfg.name))
                } else {
                    Err(format!(
                        "{} 停止失败: {}{}",
                        cfg.name,
                        e,
                        Self::stop_failure_detail("", &stop_stderr)
                    ))
                }
            }
        }
    }

    /// 停止失败时列出仍残留的进程 cmdline（帮助定位：JVM 未退出 / 误匹配 / 停止脚本失效）。
    async fn leftover_procs(
        &self,
        handle_arc: &Arc<tokio::sync::Mutex<russh::client::Handle<crate::ssh::Client>>>,
        key: &str,
    ) -> String {
        let pat = match key {
            "HDFS" => "[Nn]ame[Nn]ode|[Dd]ata[Nn]ode",
            "YARN" => "[Rr]esource[Mm]anager|[Nn]ode[Mm]anager",
            "Hive" => "[o]rg.apache.hadoop.hive.metastore.HiveMetaStore|[o]rg.apache.hive.service.server.HiveServer2",
            "DolphinScheduler" => "[o]rg.apache.dolphinscheduler.StandaloneServer|dolphinscheduler-standalone-server",
            "SparkMaster" | "SparkWorker" => "[o]rg.apache.spark.deploy.master.Master|[o]rg.apache.spark.deploy.worker.Worker",
            "MySQL" => "[m]ysqld",
            _ => return String::new(),
        };
        match exec_with_timeout(
            handle_arc,
            &format!("pgrep -af '{}' 2>/dev/null | head -5", pat),
            5,
        )
        .await
        {
            Ok((out, _stderr, _rc)) => {
                let t = out.trim();
                if t.is_empty() {
                    String::new()
                } else {
                    format!(": {}", t.replace('\n', " | "))
                }
            }
            Err(_) => String::new(),
        }
    }

    /// 停止失败诊断：合并残留进程命令行与停止命令 stderr。
    /// leftover 空（新加服务未覆盖 / 残留瞬时消失）时退化为命令错误或通用提示。
    fn stop_failure_detail(leftover: &str, stderr: &str) -> String {
        let mut detail = String::new();
        if !leftover.trim().is_empty() {
            detail.push_str(leftover.trim());
        }
        if !stderr.trim().is_empty() {
            if !detail.is_empty() {
                detail.push_str("；");
            }
            detail.push_str(&format!("命令错误: {}", stderr.trim()));
        }
        if detail.is_empty() {
            detail.push_str("（进程未退出）");
        }
        detail
    }

    /// 停止服务（带"已停止"预检查）。返回 (成功, 消息)
    pub async fn stop(
        &self,
        session_id: &str,
        handle_arc: &Arc<tokio::sync::Mutex<russh::client::Handle<crate::ssh::Client>>>,
        key: &str,
    ) -> Result<String, String> {
        let cfg = Self::find_config(key).ok_or_else(|| format!("未知服务: {}", key))?;

        let current = self.check_status(session_id, handle_arc, key).await;
        if current == ClusterServiceStatus::Stopped {
            return Ok(format!("{} 已停止", cfg.name));
        }
        self.stop_raw(session_id, handle_arc, key).await
    }

    /// 重启服务：直接执行命令后轮询监测状态返回。
    /// 支持原子重启命令（如 systemctl restart）的走单命令一步到位；
    /// 其余 stop + start（均跳预检查，restart 场景状态已知）。
    /// 快的服务（MySQL/Hive/Spark）及时返回，慢的（HDFS/YARN/Dolphin）按实际启动时间等待。
    pub async fn restart(
        &self,
        session_id: &str,
        handle_arc: &Arc<tokio::sync::Mutex<russh::client::Handle<crate::ssh::Client>>>,
        key: &str,
    ) -> Result<String, String> {
        let cfg = Self::find_config(key).ok_or_else(|| format!("未知服务: {}", key))?;

        if let Some(rcmd) = &cfg.restart_cmd {
            // 原子重启：执行后轮询就绪，一步到位。
            match exec_with_timeout(handle_arc, rcmd, 60).await {
                Ok((_stdout, stderr, rc)) => {
                    let new_status = self
                        .wait_status(
                            session_id,
                            handle_arc,
                            key,
                            ClusterServiceStatus::Running,
                            Self::start_timeout(key),
                        )
                        .await;
                    match new_status {
                        ClusterServiceStatus::Running => Ok(format!("{} 重启成功", cfg.name)),
                        ClusterServiceStatus::Degraded => Ok(format!("{} 重启（部分）", cfg.name)),
                        _ => {
                            let err = self
                                .start_failure_diag(handle_arc, key, &stderr, rc)
                                .await;
                            Err(format!("{} 重启失败: {}", cfg.name, err))
                        }
                    }
                }
                Err(e) => Err(format!("{} 重启失败: {}", cfg.name, e)),
            }
        } else {
            // 无原子命令：stop + start（均跳预检查）。
            // stop 失败不中断整个重启：Dolphin 等服务的 stop 脚本可能超时/残留，
            // 但 stop_raw 已内置 kill 兜底，进程基本能清完。无论 stop 结果如何都
            // 继续 start，避免服务被留在"已停止"；start 成功则重启成功（附停止告警）。
            let stop = self.stop_raw(session_id, handle_arc, key).await;
            let start = self.start_raw(session_id, handle_arc, key).await;
            match (stop, start) {
                (Ok(_), Ok(msg)) => Ok(msg),
                (Err(stop_err), Ok(msg)) => Ok(format!("{}（注意: {}）", msg, stop_err)),
                (_, Err(err)) => Err(err),
            }
        }
    }

    /// 生成 Web UI 地址：端口 + 子路径（如 Dolphin 的 /dolphinscheduler/ui/login）。
    pub async fn web_url(&self, key: &str, host: &str) -> Option<String> {
        let cfg = Self::find_config(key)?;
        Some(format!("http://{}:{}{}", host, cfg.web_port, cfg.web_path))
    }

    /// 汇总全部服务信息（从缓存读取）
    pub async fn list_services(&self, session_id: &str) -> Vec<ClusterServiceInfo> {
        let status_cache = self.status_cache.lock().await;
        let error_cache = self.error_cache.lock().await;
        let port_cache = self.port_cache.lock().await;

        get_service_configs()
            .into_iter()
            .map(|cfg| {
                let key = cfg.key.to_string();
                let ports = port_cache
                    .get(&Self::ckey(session_id, &key))
                    .cloned()
                    .unwrap_or_default();
                ClusterServiceInfo {
                    key: key.clone(),
                    name: cfg.name.to_string(),
                    status: status_cache
                        .get(&Self::ckey(session_id, &key))
                        .cloned()
                        .unwrap_or(ClusterServiceStatus::Unknown),
                    ports: ports.clone(),
                    error: error_cache
                        .get(&Self::ckey(session_id, &key))
                        .cloned()
                        .unwrap_or_default(),
                    // Web UI 端口：明确指定（用户环境实际值）
                    web_port: cfg.web_port,
                }
            })
            .collect()
    }

    /// 操作命令执行后重新检测单个服务的状态与端口，并返回最新信息（写入缓存）。
    pub async fn refresh_service(
        &self,
        session_id: &str,
        handle_arc: &Arc<tokio::sync::Mutex<russh::client::Handle<crate::ssh::Client>>>,
        key: &str,
    ) -> ClusterServiceInfo {
        self.check_status(session_id, handle_arc, key).await;
        let _ = self.detect_ports(session_id, handle_arc, key).await;
        self.list_services(session_id)
            .await
            .into_iter()
            .find(|s| s.key == key)
            .unwrap_or_else(|| ClusterServiceInfo {
                key: key.to_string(),
                name: key.to_string(),
                status: ClusterServiceStatus::Unknown,
                ports: String::new(),
                error: String::new(),
                web_port: 0,
            })
    }
}

// ---------- 命令：服务 ----------

/// 检测全部 7 个服务的状态与端口并返回。
/// 各服务并行检测（每个服务独立开一个 SSH 通道），总耗时 ≈ 最慢的单个服务，
/// 而非串行累加——集群未启动时能缩短近一个数量级。
#[tauri::command]
pub async fn cluster_list_services(
    app: AppHandle,
    session_id: String,
) -> Result<Vec<ClusterServiceInfo>, String> {
    let (handle_arc, _host) = get_conn(&app, &session_id).await?;
    // ClusterManager 是 Arc：并发命令不互斥（内部缓存各自独立 Mutex，外层无需锁）
    let cm = app.state::<AppState>().cluster.clone();

    let session_ids = session_id.clone();
    let cm_for_futures = cm.clone();
    let futures = get_service_configs().into_iter().map(move |cfg| {
        let handle_arc = handle_arc.clone();
        let key = cfg.key.to_string();
        let cm_ref = cm_for_futures.clone();
        let sid = session_ids.clone();
        async move {
            cm_ref.check_status(&sid, &handle_arc, &key).await;
            let _ = cm_ref.detect_ports(&sid, &handle_arc, &key).await;
        }
    });
    // 并发上限 3：7 个服务同时各开一个 SSH 通道易触发服务端通道限制
    //（如"打开通道失败"），限流后总耗时 ≈ 3×单服务耗时，依旧远快于串行
    use futures::stream::StreamExt as _;
    futures::stream::iter(futures).buffered(3).collect::<Vec<_>>().await;

    Ok(cm.list_services(&session_id).await)
}

/// 服务启停操作（start/stop/restart）。
/// 操作命令执行完后重新检测该组件的状态与端口，随结果返回给前端。
#[tauri::command]
pub async fn cluster_service_action(
    app: AppHandle,
    session_id: String,
    key: String,
    action: String,
) -> Result<ServiceActionResult, String> {
    let (handle_arc, _host) = get_conn(&app, &session_id).await?;
    // ClusterManager 是 Arc：长时间操作（单次检测 8s、启动等待最长 90s）不阻塞其他命令
    let cm = app.state::<AppState>().cluster.clone();

    let result = match action.as_str() {
        "start" => cm.start(&session_id, &handle_arc, &key).await,
        "stop" => cm.stop(&session_id, &handle_arc, &key).await,
        "restart" => cm.restart(&session_id, &handle_arc, &key).await,
        _ => Err(format!("未知操作: {}", action)),
    };

    // 命令执行完后重新检测该组件状态 + 端口（无论成败，缓存都更新，
    // 失败时前端走全量刷新兜底）。
    let service = cm.refresh_service(&session_id, &handle_arc, &key).await;

    match result {
        Ok(message) => Ok(ServiceActionResult { message, service }),
        Err(e) => Err(e),
    }
}

/// 服务日志路径映射（最新日志文件 tail 30 行）
fn log_source(key: &str) -> (&str, &str) {
    match key {
        "HDFS" => ("/opt/hadoop3/logs", "hadoop-root-namenode-*.log"),
        "YARN" => ("/opt/hadoop3/logs", "hadoop-root-resourcemanager-*.log"),
        "Hive" => ("/tmp/root", "hive.log"),
        "DolphinScheduler" => ("/tmp", "dolphinscheduler-standalone.log"),          // daemon.sh 的 start/stop 输出都落此文件；standalone-server-*.out 仅运行期 stdout
        "MySQL" => ("/var/log/mysql", "error.log"),
        "SparkMaster" => ("/opt/spark2/logs", "spark-*.log"),
        "SparkWorker" => ("/opt/spark2/logs", "spark-*.log"),
        _ => ("/tmp", "*.log"),
    }
}

/// 查看服务最新日志。
#[tauri::command]
pub async fn cluster_service_logs(
    app: AppHandle,
    session_id: String,
    key: String,
) -> Result<String, String> {
    let (handle_arc, _host) = get_conn(&app, &session_id).await?;
    let (path, pattern) = log_source(&key);
    let cmd = format!(
        "ls -t {path}/{pattern} 2>/dev/null | head -1 | xargs -r tail -30 2>/dev/null || echo 'No logs found'",
        path = path,
        pattern = pattern
    );
    let result = exec_with_timeout(&handle_arc, &format!("{}{}", SOURCE, cmd), 10).await?;
    let trimmed = result.0.trim();
    if trimmed.is_empty() || trimmed == "No logs found" {
        Ok("暂无日志".to_string())
    } else {
        Ok(trimmed.to_string())
    }
}

/// 生成服务的 Web UI 访问地址
#[tauri::command]
pub async fn cluster_web_url(
    app: AppHandle,
    session_id: String,
    key: String,
) -> Result<String, String> {
    let (_handle_arc, host) = get_conn(&app, &session_id).await?;
    let cm = app.state::<AppState>().cluster.clone();
    cm.web_url(&key, &host)
        .await
        .ok_or_else(|| "未知服务".to_string())
}

// ---------- 命令：YARN ----------

/// 列出 YARN 应用
/// 活跃的 YARN 应用列表。
/// 首选 ResourceManager REST（一次 HTTP 往返、零 JVM）：`yarn application -list`
/// 每次调用都要在远端启动一个 YARN 客户端 JVM（1~3s + 数百 MB 峰值内存），而本
/// 函数会被 15s 自动刷新反复触发。REST 不可用时回退命令行解析，行为与原先一致。
#[tauri::command]
pub async fn cluster_yarn_apps(
    app: AppHandle,
    session_id: String,
) -> Result<Vec<YarnApp>, String> {
    let (handle_arc, ssh_host) = get_conn(&app, &session_id).await?;
    let cm = app.state::<AppState>().cluster.clone();

    // None = REST 这一路不可用（端口不通 / 响应异常）→ 回退命令行
    if let Some(apps) = yarn_apps_via_rest(&handle_arc, &cm, &session_id, &ssh_host).await {
        return Ok(apps);
    }
    yarn_apps_via_cli(&handle_arc).await
}

/// 与 `yarn application -list` 默认输出等价的状态集合
///（该命令默认只列非终态应用，不含 FINISHED / KILLED / FAILED）。
const YARN_ACTIVE_STATES: &str = "NEW,NEW_SAVING,SUBMITTED,ACCEPTED,RUNNING";

/// 经 RM REST 取活跃应用。
/// 返回 `None`：REST 不可用（调用方回退命令行）；
/// 返回 `Some(vec![])`：REST 正常但当前没有活跃应用（正常结果，不是错误）。
async fn yarn_apps_via_rest(
    handle_arc: &Arc<tokio::sync::Mutex<russh::client::Handle<crate::ssh::Client>>>,
    cm: &ClusterManager,
    session_id: &str,
    ssh_host: &str,
) -> Option<Vec<YarnApp>> {
    let tunnel_hosts = yarn_tunnel_hosts(ssh_host);
    let q = format!("/ws/v1/cluster/apps?states={YARN_ACTIVE_STATES}");
    let v = rest_get_json(
        handle_arc,
        cm,
        session_id,
        ssh_host,
        &tunnel_hosts,
        8088,
        &q,
        Duration::from_secs(6),
    )
    .await
    .ok()?;

    // RM 在没有活跃应用时返回 {"apps": null}（正常情况，不是错误）
    let Some(arr) = v
        .get("apps")
        .and_then(|a| a.get("app"))
        .and_then(|a| a.as_array())
    else {
        return Some(Vec::new());
    };

    Some(
        arr.iter()
            .filter_map(|a| {
                let id = a.get("id").and_then(|x| x.as_str())?.to_string();
                if id.is_empty() {
                    return None;
                }
                let s = |k: &str| {
                    a.get(k)
                        .and_then(|x| x.as_str())
                        .unwrap_or_default()
                        .to_string()
                };
                Some(YarnApp {
                    id,
                    name: s("name"),
                    user: s("user"),
                    state: s("state"),
                    queue: s("queue"),
                    // 命令行给的是 "10%" 这类整数百分比；REST 给数字 10.0 → 统一成同款文本
                    progress: format!(
                        "{}%",
                        a.get("progress").and_then(|x| x.as_f64()).unwrap_or(0.0) as i64
                    ),
                })
            })
            .collect(),
    )
}

/// 回退路径：SSH 执行 `yarn application -list` 解析固定列（每次调用会起一个 JVM）。
async fn yarn_apps_via_cli(
    handle_arc: &Arc<tokio::sync::Mutex<russh::client::Handle<crate::ssh::Client>>>,
) -> Result<Vec<YarnApp>, String> {
    let result = exec_with_timeout(
        handle_arc,
        &format!("{}yarn application -list 2>&1", SOURCE),
        8,
    )
    .await?;

    let (stdout, _stderr, _rc) = result;
    let mut apps = Vec::new();
    let mut started = false;

    for line in stdout.lines() {
        if line.contains("Application-Id") {
            started = true;
            continue;
        }
        if !started || line.trim().is_empty() || line.starts_with("Total") {
            continue;
        }
        let parts: Vec<&str> = line.split_whitespace().collect();
        // Application-Name 可含空格，固定下标解析会整体错位。
        // 改为状态关键字锚定：从右向左找 State 列——其后 1~2 列内必有百分比
        // 进度列（有 FinalState 列时隔一列，无则紧邻），据此唯一确定 State；
        // State 前依次是 Queue、User，ID 之后到 User 之前整段为应用名。
        const STATES: [&str; 8] = [
            "NEW",
            "NEW_SAVING",
            "SUBMITTED",
            "ACCEPTED",
            "RUNNING",
            "FINISHED",
            "FAILED",
            "KILLED",
        ];
        let mut hit = None;
        for i in (1..parts.len()).rev() {
            if !STATES.contains(&parts[i]) {
                continue;
            }
            if parts.get(i + 1).is_some_and(|t| t.ends_with('%')) {
                hit = Some((i, i + 1));
                break;
            }
            if parts.get(i + 2).is_some_and(|t| t.ends_with('%')) {
                hit = Some((i, i + 2));
                break;
            }
        }
        let Some((si, pi)) = hit else { continue };
        if si < 3 {
            continue;
        }
        apps.push(YarnApp {
            id: parts[0].to_string(),
            name: parts[1..si - 2].join(" "),
            user: parts[si - 2].to_string(),
            queue: parts[si - 1].to_string(),
            state: parts[si].to_string(),
            progress: parts[pi].to_string(),
        });
    }
    Ok(apps)
}

/// 终止 YARN 应用
#[tauri::command]
pub async fn cluster_yarn_kill(
    app: AppHandle,
    session_id: String,
    app_id: String,
) -> Result<String, String> {
    let (handle_arc, _host) = get_conn(&app, &session_id).await?;
    let result = exec_with_timeout(
        &handle_arc,
        &format!("{}yarn application -kill {} 2>&1", SOURCE, sh_quote(&app_id)),
        15,
    )
    .await?;

    let (_stdout, stderr, rc) = result;
    if rc == 0 {
        Ok(format!("已终止{}", app_id))
    } else {
        Err(format!("终止失败: {}", stderr.trim()))
    }
}

// ---------- 命令：HDFS 文件浏览 ----------

/// HDFS 目录条目（hdfs dfs -ls 解析结果）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HdfsEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: String,
    pub replication: String,
    pub owner: String,
    pub group: String,
    pub date: String,
}

/// shell 单引号转义（HDFS 路径可能含空格 / 特殊字符）。
fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// Unix epoch 秒 → "YYYY-MM-DD HH:MM"（UTC，与 hdfs dfs -ls 展示格式一致）
fn format_epoch_time(secs: i64) -> String {
    // Howard Hinnant's civil_from_days 算法（无外部依赖）。
    // 关键：需先加上 719468（0000-03-01 至 1970-01-01 的天数），否则年份整体
    // 前移约 1970 年（例如 2026 年会显示成 0056）。
    let z = secs.div_euclid(86_400) + 719_468;
    let hh = secs.rem_euclid(86_400) / 3600;
    let mm = secs.rem_euclid(86_400) % 3600 / 60;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{:04}-{:02}-{:02} {:02}:{:02}", y, m, d, hh, mm)
}

/// 字节 → 人类可读大小（与 `hdfs dfs -ls -h` 风格一致：12K / 1.2G）。
fn human_size(bytes: u64) -> String {
    const G: f64 = 1024.0 * 1024.0 * 1024.0;
    const M: f64 = 1024.0 * 1024.0;
    const K: f64 = 1024.0;
    let b = bytes as f64;
    if b >= G {
        format!("{:.1}G", b / G)
    } else if b >= M {
        format!("{:.1}M", b / M)
    } else if b >= K {
        format!("{:.1}K", b / K)
    } else {
        format!("{}", bytes)
    }
}

/// 通过 SSH direct-tcpip 隧道发送原生 HTTP/1.1 请求（等价于 `ssh -L` 端口转发 + curl，
/// 但完全在应用内完成）：SSH 服务器代为连接到目标 (host, port)，随后走普通 TCP 数据流。
/// 不依赖远端安装 curl，也不启动 JVM，毫秒级完成。通道打开失败（连接被拒 / 端口不对 /
/// 服务端禁用转发）返回 Err。
async fn tunnel_http_get(
    handle_arc: &Arc<tokio::sync::Mutex<russh::client::Handle<crate::ssh::Client>>>,
    host: &str,
    port: u16,
    req: &str,
    timeout: Duration,
) -> Result<String, String> {
    // 打开通道可能因瞬时并发冲突/服务端限制失败：重试 3 次（递增间隔）
    let mut channel = None;
    for attempt in 0..3u32 {
        let handle = handle_arc.lock().await;
        match handle
            .channel_open_direct_tcpip(host.to_string(), port as u32, "127.0.0.1", 0)
            .await
        {
            Ok(chan) => {
                channel = Some(chan);
                break;
            }
            Err(e) => {
                drop(handle); // 释放锁再等待，避免 MutexGuard 跨 await
                if attempt == 2 {
                    return Err(format!("隧道 {host}:{port} 打开失败：{e}"));
                }
                tokio::time::sleep(Duration::from_millis(150 * (attempt as u64 + 1))).await;
            }
        }
    }
    let mut channel = channel.ok_or_else(|| "隧道未建立".to_string())?;
    channel
        .data_bytes(bytes::Bytes::from(req.as_bytes().to_vec()))
        .await
        .map_err(|e| format!("隧道发送请求失败：{e}"))?;
    channel.eof().await.map_err(|e| format!("隧道发送 EOF 失败：{e}"))?;

    // 读取响应直至通道关闭（我们发了 Connection: close，服务端会主动关闭）
    let inner = async {
        let mut buf: Vec<u8> = Vec::new();
        loop {
            match channel.wait().await {
                Some(russh::ChannelMsg::Data { data }) => buf.extend_from_slice(&data),
                Some(russh::ChannelMsg::ExtendedData { data, ext: _ }) => buf.extend_from_slice(&data),
                Some(russh::ChannelMsg::Close) | Some(russh::ChannelMsg::Eof) | None => break,
                Some(_) => {}
            }
        }
        buf
    };
    let buf = tokio::time::timeout(timeout, inner)
        .await
        .map_err(|_| format!("隧道 {host}:{port} 响应超时"))?;
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

/// 从 HTTP 响应文本提取 body（兼容 Content-Length 与 chunked 两种传输方式）。
fn http_body(resp: &str) -> Option<String> {
    let (head, body) = resp.split_once("\r\n\r\n")?;
    if !head.to_ascii_lowercase().contains("transfer-encoding: chunked") {
        return Some(body.to_string());
    }
    let mut out = String::new();
    let mut rest = body;
    loop {
        let crlf = rest.find("\r\n")?;
        let size = usize::from_str_radix(rest[..crlf].trim().split(';').next()?.trim(), 16).ok()?;
        rest = &rest[crlf + 2..];
        if size == 0 {
            break;
        }
        if rest.len() < size + 2 {
            return None;
        }
        out.push_str(&rest[..size]);
        rest = &rest[size + 2..];
    }
    Some(out)
}

/// URL 编码 HDFS 路径（保留 '/' 与字母数字及少数安全字符）。
fn percent_encode_path(path: &str) -> String {
    path.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '/' | '-' | '_' | '.' | '~') {
                c.to_string()
            } else {
                let mut b = [0u8; 4];
                let s = c.encode_utf8(&mut b);
                s.as_bytes()
                    .iter()
                    .map(|x| format!("%{:02X}", x))
                    .collect()
            }
        })
        .collect()
}

/// 解析 WebHDFS LISTSTATUS 响应。
/// - Ok(Some(entries))：成功拿到目录列表；
/// - Err(信息)：该端点确为 WebHDFS 但返回了错误（如路径不存在），直接透传给用户；
/// - Ok(None)：响应不是 WebHDFS 内容（端口不对、探到了别的服务），换端点重试。
fn parse_webhdfs_listing(path: &str, body: &str) -> Result<Option<Vec<HdfsEntry>>, String> {
    let v: serde_json::Value = match serde_json::from_str(body) {
        Ok(v) => v,
        Err(_) => return Ok(None),
    };
    if let Some(rem) = v.get("RemoteException") {
        let msg = rem
            .get("message")
            .and_then(|m| m.as_str())
            .unwrap_or("HDFS 操作失败")
            .to_string();
        return Err(msg);
    }
    let arr = match v
        .get("FileStatuses")
        .and_then(|s| s.get("FileStatus"))
        .and_then(|a| a.as_array())
    {
        Some(arr) => arr,
        None => return Ok(None),
    };

    let base = if path == "/" {
        String::new()
    } else {
        path.trim_end_matches('/').to_string()
    };

    let mut entries = Vec::with_capacity(arr.len());
    for fs in arr {
        let name = fs.get("pathSuffix").and_then(|x| x.as_str()).unwrap_or("").to_string();
        let is_dir = fs.get("type").and_then(|x| x.as_str()) == Some("DIRECTORY");
        let full = if base.is_empty() {
            format!("/{}", name)
        } else {
            format!("{}/{}", base, name)
        };
        entries.push(HdfsEntry {
            name,
            path: full,
            is_dir,
            size: human_size(fs.get("length").and_then(|x| x.as_u64()).unwrap_or(0)),
            replication: fs
                .get("replication")
                .and_then(|x| x.as_u64())
                .unwrap_or(0)
                .to_string(),
            owner: fs.get("owner").and_then(|x| x.as_str()).unwrap_or("").to_string(),
            group: fs.get("group").and_then(|x| x.as_str()).unwrap_or("").to_string(),
            date: format_epoch_time(
                (fs.get("modificationTime").and_then(|x| x.as_u64()).unwrap_or(0) / 1000) as i64,
            ),
        });
    }
    Ok(Some(entries))
}

/// 一次 JVM 换永久端点发现：`hdfs getconf -namenodeHttpAddress` 返回真实的
/// NameNode HTTP 地址（host:port，host 是 NameNode 实际绑定的主机名而非固定 localhost）。
async fn resolve_webhdfs_address(
    handle_arc: &Arc<tokio::sync::Mutex<russh::client::Handle<crate::ssh::Client>>>,
) -> Option<(String, u16)> {
    let cmd = format!("{}hdfs getconf -namenodeHttpAddress 2>/dev/null", SOURCE);
    let (out, _stderr, rc) = exec_with_timeout(handle_arc, &cmd, 6).await.ok()?;
    if rc != 0 {
        return None;
    }
    let out = out.trim();
    let (host, port) = out.rsplit_once(':')?;
    let port: u16 = port.trim().parse().ok()?;
    if host.trim().is_empty() {
        return None;
    }
    Some((host.trim().to_string(), port))
}

/// 每会话的 HDFS 用户（WebHDFS 的 user.name 参数）：whoami 只跑一次后缓存。
async fn resolve_hdfs_user(
    handle_arc: &Arc<tokio::sync::Mutex<russh::client::Handle<crate::ssh::Client>>>,
    cm: &ClusterManager,
    session_id: &str,
) -> Result<String, String> {
    if let Some(u) = cm.hdfs_user.lock().unwrap().get(session_id).cloned() {
        return Ok(u);
    }
    let (out, _stderr, rc) =
        exec_with_timeout(handle_arc, "whoami 2>/dev/null || echo root", 3).await?;
    let user = if rc == 0 {
        let t = out.trim().to_string();
        if t.is_empty() {
            "root".to_string()
        } else {
            t
        }
    } else {
        "root".to_string()
    };
    cm.hdfs_user
        .lock()
        .unwrap()
        .insert(session_id.to_string(), user.clone());
    Ok(user)
}

/// 本机直连 NameNode HTTP 端口发原生 HTTP/1.1 请求（与参考项目完全一致：
/// 应用直接请求 http://host:port/webhdfs/v1...，一个 TCP 往返，零 SSH 开销、无 JVM）。
/// 仅在本地网络可达集群 HTTP 端口时可用；失败由调用方落回 SSH 隧道。
async fn direct_http_get(
    host: &str,
    port: u16,
    req: &str,
    timeout: Duration,
) -> Result<String, String> {
    let addr = format!("{host}:{port}");
    let mut stream = tokio::time::timeout(
        Duration::from_secs(3),
        tokio::net::TcpStream::connect(&addr),
    )
    .await
    .map_err(|_| format!("直连 {addr} 超时"))?
    .map_err(|e| format!("直连 {addr} 失败：{e}"))?;

    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    stream
        .write_all(req.as_bytes())
        .await
        .map_err(|e| format!("直连 {addr} 发送失败：{e}"))?;
    // 请求带 Connection: close，服务端响应后主动关闭；这里再明确关闭写方向，
    // 让读循环立即等到 EOF（避免个别 Jetty 版本不按头字段关闭）
    let _ = stream.shutdown().await;

    let inner = async {
        let mut buf: Vec<u8> = Vec::new();
        let mut tmp = [0u8; 8192];
        loop {
            match stream.read(&mut tmp).await {
                Ok(0) => break,
                Ok(n) => buf.extend_from_slice(&tmp[..n]),
                Err(e) => return Err(e),
            }
        }
        Ok::<Vec<u8>, std::io::Error>(buf)
    };
    let buf = tokio::time::timeout(timeout, inner)
        .await
        .map_err(|_| format!("直连 {addr} 响应超时"))?
        .map_err(|e| format!("直连 {addr} 读取失败：{e}"))?;
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

/// 用 WebHDFS REST API 列目录。速度设计（由快到慢）：
/// 1. 本机直连 NameNode HTTP 端口（与参考项目相同：一个 TCP 往返，毫秒级）；
/// 2. SSH direct-tcpip 隧道（本地网络到集群 HTTP 端口不通时，仍不经 JVM）；
/// 3. 都不行才由调用方回退 `hdfs dfs -ls -h`。
/// 端口优先用已缓存端口，其次默认 9870/50070（无需 JVM），最后 getconf 发现自定义端口。
async fn webhdfs_list(
    handle_arc: &Arc<tokio::sync::Mutex<russh::client::Handle<crate::ssh::Client>>>,
    cm: &ClusterManager,
    session_id: &str,
    ssh_host: &str,
    path: &str,
) -> Result<Vec<HdfsEntry>, String> {
    let user = resolve_hdfs_user(handle_arc, cm, session_id).await?;
    let encoded_path = percent_encode_path(path);
    let encoded_user = percent_encode_path(&user);
    let make_req =
        |host: &str, port: u16| {
            format!(
                "GET /webhdfs/v1{encoded_path}?op=LISTSTATUS&user.name={encoded_user} HTTP/1.1\r\nHost: {host}:{port}\r\nConnection: close\r\n\r\n"
            )
        };
    // 成功回调：缓存端点并返回条目；失败返回 None 表示换下一个端点试
    let try_resp = |cm: &ClusterManager,
                    sid: &str,
                    path: &str,
                    host: &str,
                    port: u16,
                    resp: &str,
                    last_err: &mut String|
     -> Option<Result<Vec<HdfsEntry>, String>> {
        match http_body(resp) {
            Some(body) => match parse_webhdfs_listing(path, &body) {
                Ok(Some(entries)) => {
                    // 端点确认后缓存到该会话名下；同时解除直连冷却、标记探针可用
                    cm.webhdfs_endpoint
                        .lock()
                        .unwrap()
                        .insert(sid.to_string(), (host.to_string(), port));
                    cm.probe_update(sid, |p| {
                        p.ok = true;
                        p.direct_fail_ts = 0;
                    });
                    Some(Ok(entries))
                }
                Ok(None) => {
                    *last_err = format!("{host}:{port} 非 WebHDFS 响应");
                    None
                }
                Err(msg) => Some(Err(msg)),
            },
            None => {
                *last_err = format!("{host}:{port} 响应异常");
                None
            }
        }
    };

    // 端口候选（尝试顺序）：缓存端口 → 默认 9870。
    // 不再包含 50070（Hadoop 2.x 的端口），理由见 namenode_endpoints 注释。
    let cached_port = cm
        .webhdfs_endpoint
        .lock()
        .unwrap()
        .get(session_id)
        .map(|(_, p)| *p);
    let mut ports: Vec<u16> = Vec::new();
    if let Some(p) = cached_port {
        ports.push(p);
    }
    if !ports.contains(&9870) {
        ports.push(9870);
    }

    let mut last_err = "webhdfs 不可用".to_string();

    // —— 第 1 优先：本机直连（与参考项目一致，最接近零开销）——
    // 直连整体失败后冷却 5 分钟，期间直接跳去隧道，避免每击白等直连超时
    let direct_skip =
        now_secs().saturating_sub(cm.direct_fail_ts_of(session_id))
            < 300;
    if !direct_skip {
        let mut any_direct = false;
        for &port in &ports {
            match direct_http_get(ssh_host, port, &make_req(ssh_host, port), Duration::from_secs(5))
                .await
            {
                Ok(resp) => {
                    any_direct = true;
                    if let Some(r) =
                        try_resp(cm, session_id, path, ssh_host, port, &resp, &mut last_err)
                    {
                        return r;
                    }
                }
                Err(e) => {
                    last_err = e;
                }
            }
        }
        if !any_direct {
            // 直连一个都连不上（本地网络到集群 HTTP 端口不通）→ 冷却 5 分钟，
            // 期间直接走隧道，避免每击白等直连超时；端点成功后自动解除
            cm.set_direct_fail(session_id);
        }
    }

    // —— 第 2 优先：SSH direct-tcpip 隧道（直连不通/被跳过时兜底，仍不启动 JVM）——
    // 自定义端口仅在无缓存端口时才用 getconf 发现（一次 JVM）
    let mut tunnel_ports = ports.clone();
    // 隧道目标主机候选（顺序 = 尝试顺序）：
    //   ① SSH 主机自身 —— NameNode 常常只绑定局域网网卡（192.168.42.101:9870），
    //      此时从服务器侧连 localhost:9870 **必然失败**。原先候选里只有 localhost，
    //      于是直连一旦被 5 分钟冷却跳过，WebHDFS 就永久取不到数据。
    //   ② localhost 兜底（NameNode 只绑定回环的场景）。
    //   ③ getconf 发现的自定义主机名：插到最前（最贴近实际配置）。
    let mut tunnel_hosts: Vec<String> = Vec::new();
    if !ssh_host.is_empty() {
        tunnel_hosts.push(ssh_host.to_string());
    }
    tunnel_hosts.push("localhost".to_string());
    if cached_port.is_none() {
        if let Some((h, p)) = resolve_webhdfs_address(handle_arc).await {
            if !tunnel_ports.contains(&p) {
                tunnel_ports.insert(0, p);
            }
            if !h.is_empty() && !tunnel_hosts.iter().any(|x| x == &h) {
                tunnel_hosts.insert(0, h);
            }
        }
    }
    // 记录尝试过的端点，最终错误信息里一并列出（避免只报最后一个候选造成误导）
    let tried_endpoints: Vec<String> = tunnel_ports
        .iter()
        .flat_map(|p| tunnel_hosts.iter().map(move |h| format!("{h}:{p}")))
        .collect();
    for &port in &tunnel_ports {
        for host in &tunnel_hosts {
            match tunnel_http_get(handle_arc, host, port, &make_req(host, port), Duration::from_secs(6))
                .await
            {
                Ok(resp) => {
                    if let Some(r) =
                        try_resp(cm, session_id, path, host, port, &resp, &mut last_err)
                    {
                        return r;
                    }
                }
                Err(e) => {
                    last_err = e;
                }
            }
        }
    }
    Err(format!(
        "{last_err}（端点候选：{}）",
        tried_endpoints.join(", ")
    ))
}

// ---------- 集群统计图表（HDFS 存储与块 / YARN 总资源） ----------

/// HDFS 存储与块统计（来自 NameNode JMX，毫秒级，不启动 JVM）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HdfsSummary {
    pub capacity_total_gb: f64,
    pub capacity_used_gb: f64,
    pub capacity_remaining_gb: f64,
    /// 同一块磁盘上「非 HDFS」的占用（其它进程/日志/系统数据）。
    /// 必须与 capacity_used_gb 分开呈现：只画「已用 / 总量」会显示成"磁盘几乎全空"
    /// （本机实测 0.1GB / 58.8GB），而 `df` 实际已用约 40%——差额全在这一项
    ///（本机实测 15.4GB）。少了它，图和 `df` 对不上，容易误判。
    pub capacity_used_non_dfs_gb: f64,
    pub total_blocks: i64,
    pub missing_blocks: i64,
    pub under_replicated_blocks: i64,
    pub corrupt_blocks: i64,
    pub pending_deletion_blocks: i64,
    pub live_datanodes: i64,
    pub dead_datanodes: i64,
    pub total_files: i64,
    /// 当前并发读写（xceiver）数——集群"忙不忙"的轻量指标
    pub total_load: i64,
    /// 距上次 editlog checkpoint 的事务数：持续增长说明 checkpoint 没在跑
    ///（editlog 膨胀 → NameNode 重启极慢，经典故障）
    pub transactions_since_last_checkpoint: i64,
    /// 上次 checkpoint 时间（epoch ms；0 = 未知）
    pub last_checkpoint_time_ms: i64,
}

/// YARN 集群总资源（来自 ResourceManager /ws/v1/cluster/metrics）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct YarnMetrics {
    pub total_mb: i64,
    pub allocated_mb: i64,
    pub available_mb: i64,
    pub total_vcores: i64,
    pub allocated_vcores: i64,
    pub available_vcores: i64,
    pub active_nodes: i64,
    pub lost_nodes: i64,
    /// RM 判定为**不可用**的节点数（> 0 是强告警，最常见原因是该节点磁盘满）
    pub unhealthy_nodes: i64,
    pub running_apps: i64,
    pub pending_apps: i64,
    /// 累计计数（自 RM 启动）：教学场景用于"这次课提交了几个作业、几个失败"
    pub apps_submitted: i64,
    pub apps_completed: i64,
    pub apps_failed: i64,
    pub apps_killed: i64,
    pub containers_allocated: i64,
    /// 集群内存利用率（%，RM 已按百分数给出）
    pub utilized_mb_percent: f64,
}

/// NameNode JVM 统计（来自 NameNode JvmMetrics JMX，毫秒级）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NameNodeJvm {
    pub heap_used_mb: f64,
    pub heap_committed_mb: f64,
    pub heap_max_mb: f64,
    pub gc_count: i64,
    pub gc_time_ms: i64,
    pub threads: i64,
}

/// 单个 DataNode 的实时状态。
///
/// 数据取自 NameNode JMX `Hadoop:service=NameNode,name=NameNodeInfo` 的 `LiveNodes`
/// 字段，**而不是**直连 DataNode 的 9864 端口，理由：
/// ① 复用已经打通的 9870 通道（直连失败还有 SSH 隧道兜底），零新端口；
/// ② `LiveNodes` 一次给出**全部** DataNode，多节点集群天然可用，无需逐台探测；
/// ③ 含 `volfails`（卷故障数）——磁盘要坏的直接信号。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataNodeStat {
    /// 节点标识（形如 `host:9866`，即数据传输地址）
    pub id: String,
    /// Web/JMX 地址（形如 `host:9864`）
    pub info_addr: String,
    /// 机架位置
    pub location: String,
    /// 管理状态（`In Service` / `Decommissioned` …）
    pub admin_state: String,
    pub version: String,
    /// HDFS 数据实际占用（字节）
    pub used: i64,
    /// 该盘上的非 HDFS 占用（字节）
    pub non_dfs_used: i64,
    /// 该节点剩余可用（字节）
    pub remaining: i64,
    /// 该节点总容量（字节）
    pub capacity: i64,
    pub num_blocks: i64,
    /// 块池使用率（%，NameNode 已按百分比给出）
    pub block_pool_used_percent: f64,
    /// 卷故障数（> 0 = 有磁盘卷不可用）
    pub vol_fails: i64,
    /// 距上次块上报的秒数（越大越可能失联；NameNode 判定掉线约需 10 分钟）
    pub last_block_report_secs: i64,
}

/// HDFS 节点视图：DataNode 明细 + 集群级告警指标。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HdfsNodes {
    pub nodes: Vec<DataNodeStat>,
    /// 判定为 Dead 的 DataNode 数
    pub dead_nodes: i64,
    /// NameNode 是否处于安全模式（安全模式下 HDFS 只读）
    pub safemode: bool,
    /// 损坏文件数
    pub corrupt_files: i64,
    /// NameNode 本次启动时间（epoch ms）
    pub nn_started_ms: i64,
    /// 正常的元数据目录数（`NameDirStatuses.active`）
    pub active_dirs: i64,
    /// **故障的元数据目录**（`NameDirStatuses.failed` 的目录名）。
    /// 非空 = NameNode 自己的元数据目录坏了，是 HDFS 最严重的故障之一，
    /// 且从"容量/块"这类统计里完全看不出来，必须单独告警。
    pub failed_dirs: Vec<String>,
    /// 尚未落盘到 checkpoint 的事务数（`JournalTransactionInfo` 两个 TxId 之差）。
    /// 持续增大说明 checkpoint 没在跑 → editlog 膨胀 → NameNode 重启极慢。
    pub checkpoint_gap: i64,
}

/// 单个 NodeManager 的实时状态（RM `/ws/v1/cluster/nodes`）。
/// 直接回答实验室高频问题——"我的任务为什么一直 ACCEPTED 不跑"：
/// 看该节点剩余内存还能不能装下容器。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct YarnNode {
    pub id: String,
    pub state: String,
    /// 健康报告：**空字符串 = 健康**；非空是 NodeManager 给出的具体原因
    /// （如磁盘读写失败）。注意实测 Hadoop 3.x 的字段名是 `healthReport`
    ///（Hadoop 2.x 才是 `healthStatus`），代码里两个都作候选。
    pub health_report: String,
    /// NodeManager Web 地址（形如 `host:8042`）
    pub node_http_address: String,
    pub rack: String,
    pub used_memory_mb: i64,
    pub available_memory_mb: i64,
    pub used_vcores: i64,
    pub available_vcores: i64,
    pub num_containers: i64,
    /// NodeManager 上报的物理内存利用率（%）
    pub mem_utilization: f64,
    /// 最近一次心跳时间（epoch ms；0 = 未知）
    pub last_health_update_ms: i64,
}

/// 从 JMX/JSON 对象按候选键名列表取值（f64）。
fn jmx_num(bean: &serde_json::Value, keys: &[&str]) -> f64 {
    for k in keys {
        if let Some(n) = bean.get(*k).and_then(|v| v.as_f64()) {
            return n;
        }
    }
    0.0
}

/// 从 JMX/JSON 对象按候选键名列表取值（i64）。
fn jmx_int(bean: &serde_json::Value, keys: &[&str]) -> i64 {
    for k in keys {
        if let Some(n) = bean.get(*k).and_then(|v| v.as_i64()) {
            return n;
        }
    }
    0
}

/// 从 JMX/JSON 对象按候选键名列表取布尔值。
///
/// JMX 里布尔字段的形态很不稳定，两种都要认：
/// - 真布尔（`true`/`false`）；
/// - **描述字符串**——例如 Hadoop 的 `Safemode`：不在安全模式时是空串 `""`，
///   在安全模式时是一段说明文本（**不是** `"true"`）。若只认 `"true"`
///   就会在"真的进了安全模式"时漏判，所以此处约定：非空且非否定词 = true。
fn jmx_bool(bean: &serde_json::Value, keys: &[&str]) -> bool {
    for k in keys {
        if let Some(v) = bean.get(*k) {
            if let Some(b) = v.as_bool() {
                return b;
            }
            if let Some(s) = v.as_str() {
                let s = s.trim();
                if s.is_empty() || s.eq_ignore_ascii_case("false") || s == "0" {
                    return false;
                }
                return true;
            }
        }
    }
    false
}

/// REST GET（本机直连优先，SSH 隧道兜底）→ JSON。与 WebHDFS 列表共用直连冷却，
/// 直连整体不通时自动改走隧道，仍不启动 JVM。
async fn rest_get_json(
    handle_arc: &Arc<tokio::sync::Mutex<russh::client::Handle<crate::ssh::Client>>>,
    cm: &ClusterManager,
    session_id: &str,
    ssh_host: &str,
    tunnel_hosts: &[String],
    port: u16,
    path_and_query: &str,
    timeout: Duration,
) -> Result<serde_json::Value, String> {
    let make_req = |host: &str| {
        format!(
            "GET {path_and_query} HTTP/1.1\r\nHost: {host}:{port}\r\nConnection: close\r\n\r\n"
        )
    };
    let mut last_err = "REST 不可用".to_string();
    let direct_skip = now_secs()
        .saturating_sub(cm.direct_fail_ts_of(session_id))
        < 300;
    if !direct_skip {
        match direct_http_get(ssh_host, port, &make_req(ssh_host), timeout).await {
            Ok(r) => match http_body(&r) {
                Some(b) => {
                    return serde_json::from_str(&b).map_err(|e| format!("JSON 解析失败：{e}"));
                }
                None => last_err = format!("{ssh_host}:{port} 响应异常"),
            },
            Err(e) => last_err = e,
        }
    }
    for host in tunnel_hosts {
        match tunnel_http_get(handle_arc, host, port, &make_req(host), timeout).await {
            Ok(r) => match http_body(&r) {
                Some(b) => {
                    return serde_json::from_str(&b).map_err(|e| format!("JSON 解析失败：{e}"));
                }
                None => last_err = format!("{host}:{port} 响应异常"),
            },
            Err(e) => last_err = e,
        }
    }
    Err(last_err)
}

/// YARN（ResourceManager）隧道回退的候选目标主机：先本机回环，再 SSH 主机自身。
/// 与 HDFS 的 `namenode_endpoints` 同思路——RM 可能只绑定在局域网网卡上，
/// 此时从服务器侧连 `localhost:8088` 会失败，需要用主机地址兜底。
/// 注：这只是失败链上的**追加尝试**，第一个候选成功即返回，happy path 完全不变。
fn yarn_tunnel_hosts(ssh_host: &str) -> Vec<String> {
    let mut hosts = vec!["localhost".to_string()];
    if !ssh_host.is_empty() && ssh_host != "localhost" {
        hosts.push(ssh_host.to_string());
    }
    hosts
}

/// 解析 NameNode HTTP 候选端口与隧道目标主机（与 WebHDFS / 统计图表共用）。
/// 返回 (候选端口, 隧道目标主机)。先把缓存拷出立即释放锁。
///
/// ⚠️ **端口候选里不再包含 50070**：那是 Hadoop 2.x 的 NameNode Web UI 端口，
/// 本环境是 Hadoop 3.3.6（9870）。留着它只有一个后果——所有候选都失败时，
/// 最终错误信息报成 `localhost:50070 ...`，把排查方向完全带偏
/// （用户实测就是这样：一直提示 50070 未启动，其实他的端口是 9870）。
/// 自定义端口由「缓存端口 → resolve_webhdfs_address(getconf)」兜住，不需要 50070。
///
/// ⚠️ **隧道目标主机必须包含 SSH 主机自身**（与 `yarn_tunnel_hosts` 对称）：
/// NameNode 可能只绑定在局域网网卡上（`dfs.namenode.http-address=192.168.x.x:9870`），
/// 此时从服务器侧连 `localhost:9870` 必然失败。原先只在「已有缓存端点」时才加主机兜底，
/// 于是**首次探测**（无缓存）一旦直连被 5 分钟冷却跳过，HDFS 取数就永久失败 → 图表空白。
/// 顺序：缓存主机（已被证明可用）→ SSH 主机 → localhost。
fn namenode_endpoints(
    cm: &ClusterManager,
    session_id: &str,
    ssh_host: &str,
) -> (Vec<u16>, Vec<String>) {
    let endpoint = cm
        .webhdfs_endpoint
        .lock()
        .unwrap()
        .get(session_id)
        .cloned();
    let mut ports: Vec<u16> = Vec::new();
    if let Some((_, p)) = &endpoint {
        ports.push(*p);
    }
    if !ports.contains(&9870) {
        ports.push(9870);
    }

    let mut tunnel_hosts: Vec<String> = Vec::new();
    if let Some((h, _)) = &endpoint {
        if !h.is_empty() {
            tunnel_hosts.push(h.clone());
        }
    }
    if !ssh_host.is_empty() && !tunnel_hosts.iter().any(|h| h == ssh_host) {
        tunnel_hosts.push(ssh_host.to_string());
    }
    if !tunnel_hosts.iter().any(|h| h == "localhost") {
        tunnel_hosts.push("localhost".to_string());
    }
    (ports, tunnel_hosts)
}

/// HDFS 存储与块统计（NameNode JMX，直连/隧道，毫秒级）。
#[tauri::command]
pub async fn cluster_hdfs_summary(
    app: AppHandle,
    session_id: String,
) -> Result<HdfsSummary, String> {
    let (handle_arc, ssh_host) = get_conn(&app, &session_id).await?;
    let cm = app.state::<AppState>().cluster.clone();
    let (ports, tunnel_hosts) = namenode_endpoints(&cm, &session_id, &ssh_host);

    let q = "/jmx?qry=Hadoop:service=NameNode,name=FSNamesystem";
    // 收集**每一次**尝试的失败原因：原先只保留 last_err，于是最终只显示排在最后的
    // 候选（如 localhost:50070），把真正相关的失败（本机直连 9870）掩盖掉，
    // 让人误以为"端口写错了"。
    let mut tried: Vec<String> = Vec::new();
    for &port in &ports {
        match rest_get_json(
            &handle_arc,
            &cm,
            &session_id,
            &ssh_host,
            &tunnel_hosts,
            port,
            q,
            Duration::from_secs(6),
        )
        .await
        {
            Ok(v) => {
                if let Some(bean) = v.get("beans").and_then(|a| a.as_array()).and_then(|a| a.first()) {
                    return Ok(build_hdfs_summary(bean));
                }
                tried.push(format!("{port} 端口未返回 FSNamesystem"));
            }
            Err(e) => tried.push(e),
        }
    }
    Err(format!("NameNode JMX 不可用（已尝试：{}）", tried.join("；")))
}

/// YARN 集群总资源（ResourceManager /ws/v1/cluster/metrics）。
#[tauri::command]
pub async fn cluster_yarn_metrics(
    app: AppHandle,
    session_id: String,
) -> Result<YarnMetrics, String> {
    let (handle_arc, ssh_host) = get_conn(&app, &session_id).await?;
    let cm = app.state::<AppState>().cluster.clone();

    let tunnel_hosts = yarn_tunnel_hosts(&ssh_host);
    let q = "/ws/v1/cluster/metrics";
    let mut last_err = "ResourceManager API 不可用".to_string();
    for &port in &[8088u16] {
        match rest_get_json(
            &handle_arc,
            &cm,
            &session_id,
            &ssh_host,
            &tunnel_hosts,
            port,
            q,
            Duration::from_secs(6),
        )
        .await
        {
            Ok(v) => {
                let Some(m) = v.get("clusterMetrics") else {
                    last_err = format!("端口 {port} 未返回 clusterMetrics");
                    continue;
                };
                return Ok(YarnMetrics {
                    total_mb: jmx_int(m, &["totalMB"]),
                    allocated_mb: jmx_int(m, &["allocatedMB"]),
                    available_mb: jmx_int(m, &["availableMB"]),
                    total_vcores: jmx_int(m, &["totalVirtualCores"]),
                    allocated_vcores: jmx_int(m, &["allocatedVirtualCores"]),
                    available_vcores: jmx_int(m, &["availableVirtualCores"]),
                    active_nodes: jmx_int(m, &["activeNodes"]),
                    lost_nodes: jmx_int(m, &["lostNodes"]),
                    unhealthy_nodes: jmx_int(m, &["unhealthyNodes"]),
                    running_apps: jmx_int(m, &["appsRunning"]),
                    pending_apps: jmx_int(m, &["appsPending"]),
                    apps_submitted: jmx_int(m, &["appsSubmitted"]),
                    apps_completed: jmx_int(m, &["appsCompleted"]),
                    apps_failed: jmx_int(m, &["appsFailed"]),
                    apps_killed: jmx_int(m, &["appsKilled"]),
                    containers_allocated: jmx_int(m, &["containersAllocated"]),
                    utilized_mb_percent: jmx_num(m, &["utilizedMBPercent"]),
                });
            }
            Err(e) => last_err = e,
        }
    }
    Err(last_err)
}

/// NameNode JVM 统计（JvmMetrics JMX，直连/隧道，毫秒级）。
#[tauri::command]
pub async fn cluster_namenode_jvm(
    app: AppHandle,
    session_id: String,
) -> Result<NameNodeJvm, String> {
    let (handle_arc, ssh_host) = get_conn(&app, &session_id).await?;
    let cm = app.state::<AppState>().cluster.clone();
    let (ports, tunnel_hosts) = namenode_endpoints(&cm, &session_id, &ssh_host);

    let q = "/jmx?qry=Hadoop:service=NameNode,name=JvmMetrics";
    let mut tried: Vec<String> = Vec::new();
    for &port in &ports {
        match rest_get_json(
            &handle_arc,
            &cm,
            &session_id,
            &ssh_host,
            &tunnel_hosts,
            port,
            q,
            Duration::from_secs(6),
        )
        .await
        {
            Ok(v) => {
                if let Some(bean) = v
                    .get("beans")
                    .and_then(|a| a.as_array())
                    .and_then(|a| a.first())
                {
                    return Ok(build_namenode_jvm(bean));
                }
                tried.push(format!("{port} 端口未返回 JvmMetrics"));
            }
            Err(e) => tried.push(e),
        }
    }
    Err(format!("NameNode JVM JMX 不可用（已尝试：{}）", tried.join("；")))
}

/// 从 FSNamesystem JMX bean 汇总 HDFS 统计。
fn build_hdfs_summary(bean: &serde_json::Value) -> HdfsSummary {
    const GB: f64 = 1_073_741_824.0;
    HdfsSummary {
        capacity_total_gb: jmx_num(bean, &["CapacityTotal", "Total", "TotalSpace"]) / GB,
        capacity_used_gb: jmx_num(bean, &["CapacityUsed", "Used", "UsedSpace"]) / GB,
        capacity_remaining_gb: jmx_num(bean, &["CapacityRemaining", "Free", "FreeSpace"]) / GB,
        capacity_used_non_dfs_gb: jmx_num(bean, &["CapacityUsedNonDFS", "NonDfsUsedSpace"]) / GB,
        total_blocks: jmx_int(bean, &["TotalBlocks", "BlocksTotal"]),
        missing_blocks: jmx_int(
            bean,
            &["MissingBlocks", "NumberOfMissingBlocks", "MissingBlocksCount"],
        ),
        under_replicated_blocks: jmx_int(
            bean,
            &["UnderReplicatedBlocks", "NumberOfUnderReplicatedBlocks"],
        ),
        corrupt_blocks: jmx_int(bean, &["CorruptBlocks", "CorruptBlocksCount"]),
        pending_deletion_blocks: jmx_int(bean, &["PendingDeletionBlocks"]),
        live_datanodes: jmx_int(bean, &["NumLiveDataNodes", "LiveDataNodeCount"]),
        dead_datanodes: jmx_int(bean, &["NumDeadDataNodes", "DeadDataNodeCount"]),
        total_files: jmx_int(bean, &["TotalFiles", "FilesTotal", "NumberOfFiles"]),
        total_load: jmx_int(bean, &["TotalLoad"]),
        transactions_since_last_checkpoint: jmx_int(bean, &["TransactionsSinceLastCheckpoint"]),
        last_checkpoint_time_ms: jmx_int(bean, &["LastCheckpointTime"]),
    }
}

/// 从 JvmMetrics JMX bean 汇总 NameNode JVM 统计。
fn build_namenode_jvm(bean: &serde_json::Value) -> NameNodeJvm {
    NameNodeJvm {
        heap_used_mb: jmx_num(bean, &["MemHeapUsedM"]),
        heap_committed_mb: jmx_num(bean, &["MemHeapCommittedM"]),
        heap_max_mb: jmx_num(bean, &["MemHeapMaxM"]),
        gc_count: jmx_int(bean, &["GcCount"]),
        gc_time_ms: jmx_int(bean, &["GcTimeMillis"]),
        threads: jvm_threads_total(bean),
    }
}

/// 取 JVM 线程总数。
/// 注意：Hadoop 的 JvmMetrics MBean **并不导出** 名为 `Threads` 的属性
/// （实测 Hadoop 3.x 只提供 ThreadsNew / ThreadsRunnable / ThreadsBlocked /
/// ThreadsWaiting / ThreadsTimedWaiting / ThreadsTerminated 六个分状态计数）。
/// 原先只查 `Threads` 恒返回 0，导致 JVM 图表"线程数"永远是 0。
/// 这里先兼容旧版本/其它发行版可能存在的 `Threads`，再退化为六个分状态求和。
fn jvm_threads_total(bean: &serde_json::Value) -> i64 {
    if let Some(n) = bean.get("Threads").and_then(|v| v.as_i64()) {
        return n;
    }
    [
        "ThreadsNew",
        "ThreadsRunnable",
        "ThreadsBlocked",
        "ThreadsWaiting",
        "ThreadsTimedWaiting",
        "ThreadsTerminated",
    ]
    .iter()
    .map(|k| jmx_int(bean, &[k]))
    .sum()
}

/// 解析 JMX 中以**「JSON 字符串」形式承载**的字段。
/// `LiveNodes` / `DeadNodes` / `NameDirStatuses` / `JournalTransactionInfo` 都是这种形态：
/// 它们在 JSON 里是 `"{\"...\": ...}"` 字符串，必须再 `from_str` 一次才能当对象用。
fn parse_json_str(bean: &serde_json::Value, key: &str) -> Option<serde_json::Value> {
    bean.get(key)
        .and_then(|v| v.as_str())
        .and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok())
}

/// 从 NameNode JMX `NameNodeInfo` bean 汇总 DataNode 明细与集群级告警指标。
/// 注意：`LiveNodes` / `DeadNodes` 是**JSON 字符串**（JMX 只暴露字符串），
/// 需要二次解析成对象（形如 `{"host:9866": { "infoAddr": ..., "volfails": ... }}`）。
fn build_hdfs_nodes(bean: &serde_json::Value) -> HdfsNodes {
    let parse_map = |key: &str| -> serde_json::Map<String, serde_json::Value> {
        parse_json_str(bean, key)
            .and_then(|v| v.as_object().cloned())
            .unwrap_or_default()
    };

    let nodes = parse_map("LiveNodes")
        .iter()
        .map(|(id, dn)| {
            let s = |k: &str| {
                dn.get(k)
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string()
            };
            DataNodeStat {
                id: id.clone(),
                info_addr: s("infoAddr"),
                location: s("location"),
                admin_state: s("adminState"),
                version: s("version"),
                used: jmx_int(dn, &["used", "usedSpace"]),
                non_dfs_used: jmx_int(dn, &["nonDfsUsedSpace"]),
                remaining: jmx_int(dn, &["remaining"]),
                capacity: jmx_int(dn, &["capacity"]),
                num_blocks: jmx_int(dn, &["numBlocks"]),
                block_pool_used_percent: jmx_num(dn, &["blockPoolUsedPercent"]),
                vol_fails: jmx_int(dn, &["volfails", "volFails"]),
                last_block_report_secs: jmx_int(dn, &["lastBlockReport"]),
            }
        })
        .collect();

    // 元数据目录健康：{"active": {"<dir>": "IMAGE_AND_EDITS"}, "failed": {...}}
    // failed 非空 = NameNode 的元数据目录坏了（HDFS 最严重故障之一）
    let dir_statuses = parse_json_str(bean, "NameDirStatuses");
    let dir_count = |side: &str| -> i64 {
        dir_statuses
            .as_ref()
            .and_then(|v| v.get(side))
            .and_then(|v| v.as_object())
            .map(|m| m.len() as i64)
            .unwrap_or(0)
    };
    let failed_dirs: Vec<String> = dir_statuses
        .as_ref()
        .and_then(|v| v.get("failed"))
        .and_then(|v| v.as_object())
        .map(|m| m.keys().cloned().collect())
        .unwrap_or_default();

    // checkpoint 滞后：{"MostRecentCheckpointTxId":"18186","LastAppliedOrWrittenTxId":"18187"}
    // 两者之差 = 尚未 checkpoint 的事务数，比 TransactionsSinceLastCheckpoint 更权威。
    let journal = parse_json_str(bean, "JournalTransactionInfo");
    let tx_id = |k: &str| -> i64 {
        journal
            .as_ref()
            .and_then(|v| v.get(k))
            .and_then(|v| v.as_str())
            .and_then(|s| s.parse::<i64>().ok())
            .unwrap_or(0)
    };
    let checkpoint_gap = (tx_id("LastAppliedOrWrittenTxId") - tx_id("MostRecentCheckpointTxId")).max(0);

    HdfsNodes {
        nodes,
        dead_nodes: parse_map("DeadNodes").len() as i64,
        safemode: jmx_bool(bean, &["Safemode"]),
        corrupt_files: jmx_int(bean, &["CorruptFilesCount"]),
        nn_started_ms: jmx_int(bean, &["NNStartedTimeInMillis"]),
        active_dirs: dir_count("active"),
        failed_dirs,
        checkpoint_gap,
    }
}

/// 底层查询单个目录：WebHDFS 优先（毫秒级，避免每次启动 hdfs 客户端 JVM）；
/// WebHDFS 探测失败后本会话内冷却（webhdfs_ok + 30s 冷却），冷却期间直接回退
/// `hdfs dfs -ls -h`。
async fn fetch_hdfs_list(
    cm: &ClusterManager,
    handle_arc: &Arc<tokio::sync::Mutex<russh::client::Handle<crate::ssh::Client>>>,
    session_id: &str,
    host: &str,
    p: &str,
) -> Result<Vec<HdfsEntry>, String> {
    // WebHDFS 优先（探针可用/冷却结束可重试；路径经 percent-encode，无需限制字符集）
    let use_webhdfs = {
        let pr = cm.probe_get(session_id);
        // 失败进入 30s 冷却：期间直接走 hdfs 命令不白等；冷却结束自动重新探测
        pr.ok || now_secs().saturating_sub(pr.fail_ts) > 30
    };
    if use_webhdfs {
        match webhdfs_list(handle_arc, cm, session_id, host, p).await {
            Ok(entries) => return Ok(entries),
            Err(_) => {
                // 记录失败时间并禁用，冷却结束后自动重试
                cm.probe_update(session_id, |pr| {
                    pr.ok = false;
                    pr.fail_ts = now_secs();
                });
            }
        }
    }

    let cmd = format!("{}hdfs dfs -ls -h {} 2>&1", SOURCE, sh_quote(p));
    let (stdout, _stderr, rc) = exec_with_timeout(handle_arc, &cmd, 10).await?;

    // 命令失败（路径不存在 / HDFS 未就绪）时把错误输出透传
    if rc != 0 {
        let msg = stdout.trim();
        if !msg.is_empty() {
            return Err(msg.lines().last().unwrap_or("HDFS 命令执行失败").to_string());
        }
        return Err("HDFS 命令执行失败".to_string());
    }

    let mut entries = Vec::new();
    for line in stdout.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        // 跳过 "Found N items" 头行和 "WARNING: ..." 等提示。
        if trimmed.starts_with("Found ") || trimmed.starts_with("WARNING:") {
            continue;
        }
        let parts: Vec<&str> = trimmed.split_whitespace().collect();
        // 标准格式（hadoop 3 的 -h 人类可读大小，大小为一个 token）：
        // drwxr-xr-x   - root supergroup          0 2023-06-01 10:30 /user
        // -rw-r--r--   3 root supergroup       12K 2023-06-01 10:30 /user/a.txt
        // Hadoop 2 的 -h 会把大小拆成两个 token（"160 K"），导致后续列整体右移：
        // -rw-r--r--   3 root supergroup  160 K 2023-06-01 10:30 /user/a.txt
        // 因此以 "YYYY-MM-DD HH:MM" 日期列为锚点解析，兼容两种格式。
        let date_idx = parts.iter().position(|t| {
            t.len() == 10
                && t.as_bytes().get(4) == Some(&b'-')
                && t.as_bytes().get(7) == Some(&b'-')
                && t.bytes().all(|b| b.is_ascii_digit() || b == b'-')
        });
        let Some(di) = date_idx else { continue };
        // 至少需要 4 个头部字段 + 1 个大小字段 + 日期(2) + 路径(1)
        if di < 5 || di + 2 >= parts.len() {
            continue;
        }
        // 大小：头部之后到日期前的全部 token 拼接（兼容 "12K" 与 "160 K"）
        let size = parts[4..di].join("");
        let full = parts[di + 2..].join(" ");
        let name = full
            .rsplit('/')
            .next()
            .unwrap_or(&full)
            .to_string();
        entries.push(HdfsEntry {
            is_dir: parts[0].starts_with('d'),
            name,
            path: full,
            size,
            replication: parts[1].to_string(),
            owner: parts[2].to_string(),
            group: parts[3].to_string(),
            date: format!("{} {}", parts[di], parts[di + 1]),
        });
    }
    Ok(entries)
}

/// DataNode 明细 + 集群级 HDFS 告警指标（NameNode JMX `NameNodeInfo`，复用 9870 通道）。
#[tauri::command]
pub async fn cluster_hdfs_nodes(
    app: AppHandle,
    session_id: String,
) -> Result<HdfsNodes, String> {
    let (handle_arc, ssh_host) = get_conn(&app, &session_id).await?;
    let cm = app.state::<AppState>().cluster.clone();
    let (ports, tunnel_hosts) = namenode_endpoints(&cm, &session_id, &ssh_host);

    let q = "/jmx?qry=Hadoop:service=NameNode,name=NameNodeInfo";
    let mut tried: Vec<String> = Vec::new();
    for &port in &ports {
        match rest_get_json(
            &handle_arc,
            &cm,
            &session_id,
            &ssh_host,
            &tunnel_hosts,
            port,
            q,
            Duration::from_secs(6),
        )
        .await
        {
            Ok(v) => {
                if let Some(bean) = v.get("beans").and_then(|a| a.as_array()).and_then(|a| a.first())
                {
                    return Ok(build_hdfs_nodes(bean));
                }
                tried.push(format!("{port} 端口未返回 NameNodeInfo"));
            }
            Err(e) => tried.push(e),
        }
    }
    Err(format!(
        "NameNode NameNodeInfo JMX 不可用（已尝试：{}）",
        tried.join("；")
    ))
}

/// NodeManager 明细（RM `/ws/v1/cluster/nodes`）。
/// 用于回答"任务为什么一直 ACCEPTED 不跑"——看节点剩余内存是否还装得下容器。
#[tauri::command]
pub async fn cluster_yarn_nodes(
    app: AppHandle,
    session_id: String,
) -> Result<Vec<YarnNode>, String> {
    let (handle_arc, ssh_host) = get_conn(&app, &session_id).await?;
    let cm = app.state::<AppState>().cluster.clone();
    let tunnel_hosts = yarn_tunnel_hosts(&ssh_host);

    let v = rest_get_json(
        &handle_arc,
        &cm,
        &session_id,
        &ssh_host,
        &tunnel_hosts,
        8088,
        "/ws/v1/cluster/nodes",
        Duration::from_secs(6),
    )
    .await?;

    // 没有可用 NodeManager 时 RM 返回 {"nodes":null}（正常情况，不是错误）
    let Some(arr) = v
        .get("nodes")
        .and_then(|n| n.get("node"))
        .and_then(|n| n.as_array())
    else {
        return Ok(Vec::new());
    };

    Ok(arr
        .iter()
        .filter_map(|n| {
            let id = n.get("id").and_then(|x| x.as_str())?.to_string();
            let s = |k: &str| {
                n.get(k)
                    .and_then(|x| x.as_str())
                    .unwrap_or_default()
                    .to_string()
            };
            Some(YarnNode {
                id,
                state: s("state"),
                // 实测 Hadoop 3.x 是 healthReport；2.x 是 healthStatus → 两个都试
                health_report: {
                    let a = s("healthReport");
                    if a.is_empty() {
                        s("healthStatus")
                    } else {
                        a
                    }
                },
                node_http_address: s("nodeHTTPAddress"),
                rack: s("rack"),
                used_memory_mb: jmx_int(n, &["usedMemoryMB"]),
                available_memory_mb: jmx_int(n, &["availMemoryMB"]),
                used_vcores: jmx_int(n, &["usedVirtualCores"]),
                available_vcores: jmx_int(n, &["availableVirtualCores"]),
                num_containers: jmx_int(n, &["numContainers"]),
                mem_utilization: jmx_num(n, &["memUtilization"]),
                last_health_update_ms: jmx_int(n, &["lastHealthUpdate"]),
            })
        })
        .collect())
}

/// 列出 HDFS 指定目录下的条目
///
/// 路径约定：必须以 '/' 开头；缺省由前端传 '/'。
/// 性能优化（点击进入 / 返回上一级要求快速响应）：
/// 1. 目录列表按 (会话, 路径) 缓存 20s——返回上一级、重进刚看过的目录瞬时返回；
/// 2. 并发去重：同一路径同时多次请求共享一次底层查询，避免快速连点启动多个 JVM；
/// 3. WebHDFS 优先（毫秒级），失败才回退 `hdfs dfs -ls -h`（JVM 冷启动 5~10s）。
/// `force` 为 true 时跳过缓存（手动刷新按钮用），直接重新拉取并回写缓存。
#[tauri::command]
pub async fn cluster_hdfs_list(
    app: AppHandle,
    session_id: String,
    path: String,
    force: bool,
) -> Result<Vec<HdfsEntry>, String> {
    let (handle_arc, host) = get_conn(&app, &session_id).await?;

    // 规范化：空路径回退根目录，并清理多余的结尾斜杠
    let mut p = path.trim().to_string();
    if p.is_empty() || p == "/" {
        p = "/".to_string();
    } else {
        while p.ends_with('/') && p.len() > 1 {
            p.pop();
        }
    }

    let cm = app.state::<AppState>().cluster.clone();
    let key = (session_id, p);

    // 手动刷新：绕过缓存与并发去重，直接拉取最新结果并回写缓存
    if force {
        let entries = fetch_hdfs_list(&cm, &handle_arc, &key.0, &host, &key.1).await?;
        cm.hdfs_cache
            .lock()
            .unwrap()
            .insert(key, (now_secs(), entries.clone()));
        return Ok(entries);
    }

    // 缓存命中：20s 内同目录直接返回（返回 / 重进目录瞬时响应）
    let now = now_secs();
    if let Some((t, entries)) = cm.hdfs_cache.lock().unwrap().get(&key).cloned() {
        if now.saturating_sub(t) < HDFS_CACHE_TTL_SECS {
            return Ok(entries);
        }
    }

    // 并发去重：同一 (会话, 路径) 的并发请求共享一次底层查询。
    // OnceCell 只允许第一个任务真正执行，其余等待同一结果。
    let cell = cm
        .hdfs_inflight
        .lock()
        .unwrap()
        .entry(key.clone())
        .or_insert_with(|| Arc::new(tokio::sync::OnceCell::new()))
        .clone();
    let res = cell
        .get_or_try_init(|| {
            let cm = cm.clone();
            let handle_arc = handle_arc.clone();
            let session_id = key.0.clone();
            let host = host.clone();
            let path = key.1.clone();
            async move { fetch_hdfs_list(&cm, &handle_arc, &session_id, &host, &path).await }
        })
        .await
        .cloned();

    // 成功回写缓存；无论成败都移除 in-flight 记录（后续新请求按缓存/重新查询处理）
    if let Ok(entries) = &res {
        cm.hdfs_cache
            .lock()
            .unwrap()
            .insert(key.clone(), (now_secs(), entries.clone()));
    }
    cm.hdfs_inflight.lock().unwrap().remove(&key);

    res
}
