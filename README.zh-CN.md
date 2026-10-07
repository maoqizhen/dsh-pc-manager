# dsh-pc-manager — 电脑管家

[English](README.md) · [简体中文](README.zh-CN.md)

> DeepSeek Harness plugin for system monitoring & junk cleanup · 系统监控、垃圾清理与应用卸载的 DeepSeek Harness 插件

DeepSeek Harness (dsh) 的电脑管家插件（官方 bundle 格式），提供：系统状态监控（模型工具 +
右侧边栏仪表盘）、系统垃圾清理（零 LLM 直执行窗口）、软件卸载（M3），共 5 个模型可见工具。

**平台支持**：监控（`pc_status` + 仪表盘）与垃圾清理（`pc_junk_scan`/`pc_junk_clean` + 清理窗口）
在 **macOS、Linux 与 Windows** 上工作；其余平台返回 `unsupported_platform`。Windows 侧指标取自
node 内建 + 单次批量 PowerShell 探针（见[Windows 数据来源](#windows-数据来源)），垃圾注册表为
`JUNK_TARGETS_WIN32`，回收走真实回收站（Recycle Bin）。

定位是**安全第一**的 agent 系统工具：扫描永远 dry-run；破坏性工具默认 `disabled_by_config`，
宿主显式开启才动手；回收/卸载默认进废纸篓（可恢复）；id 校验链任一失败**整体拒绝零删除**。

## 目录

- [快速开始](#快速开始)
  - [安装（一行）](#安装一行)
  - [启用垃圾清理（可选）](#启用垃圾清理可选)
  - [手动挂载（兜底，与 bundle 安装二选一）](#手动挂载兜底与-bundle-安装二选一)
- [功能](#功能)
  - [模型工具](#模型工具)
  - [仪表盘（右侧边栏）](#仪表盘右侧边栏)
  - [垃圾清理（零 LLM 直执行窗口）](#垃圾清理零-llm-直执行窗口)
- [安全设计](#安全设计)
- [附录](#附录)
  - [监控指标与数据来源](#监控指标与数据来源)
  - [Windows 数据来源](#windows-数据来源)
  - [能力门控探针](#能力门控探针)
  - [垃圾目标注册表（按平台分派）](#垃圾目标注册表按平台分派)
  - [反向代理 / 前缀挂载部署](#反向代理--前缀挂载部署)
- [仓库结构](#仓库结构)
- [本地开发](#本地开发)
- [里程碑](#里程碑)
- [License](#license)

## 快速开始

### 安装（一行）

本仓库是官方 **bundle 插件**格式（根 `package.json` 的 `dsh.bundle` + `dsh.client`），
构建产物 `lib/` 已提交，git 安装无需任何构建步骤：

```sh
dsh plugin --profile web add "github:maoqizhen/dsh-pc-manager#main"
```

装完**重启 `dsh web`**（bundle 层在启动时合成）。更新 `dsh plugin --profile web update dsh-pc-manager`，
卸载 `dsh plugin --profile web remove dsh-pc-manager`，均需重启生效。

> **需要 pnpm**：`dsh plugin` 是 pnpm 转发器，PATH 里没有 pnpm 会直接失败
> （`npm i -g pnpm` 安装；pnpm 主版本需与 profile 现有 store 一致）。服务器上若以非登录
> shell 跑 dsh，确认 `node`/`pnpm` 对该进程的 PATH 可见（如放进 `/usr/local/bin`）。

### 启用垃圾清理（可选）

安装即安全默认：只读工具开箱即用，两个破坏性工具（`pc_junk_clean` / `pc_app_uninstall`）
拒绝执行（`disabled_by_config`）。要启用垃圾清理，在**后层 patch**（profile 的
`cordis.patch.yml` 或 `~/.dsh/cordis.patch.yml`，后层整行替换 config，需重述全部键）写入：

```yaml
- insert:
    - id: pc-manager
      name: dsh-pc-manager
      config:
        enableJunkClean: true     # 仍需通过每次调用的宿主审批闸门
        moveToTrash: true         # 默认进废纸篓（可恢复）
```

### 手动挂载（兜底，与 bundle 安装二选一）

无需 `dsh plugin add`，但必须**双 entry**（包名挂载让 client 半被 `clientModules` 扫描发现，
文件路径挂载让 host 半的 `apply` 执行；官方 bundle 安装无此问题）：

```bash
# 1. 让 profile 能按包名解析（client 半的发现机制走 require.resolve('<pkg>/package.json')）
ln -s "$PWD" ~/.dsh/profiles/web/node_modules/dsh-pc-manager

# 2. 在 ~/.dsh/cordis.patch.yml 追加双 entry（host 走绝对路径，client 走包名）
# - insert:
#     - id: pc-manager
#       name: /abs/path/to/dsh-pc-manager/lib/index.js
#     - id: pc-manager-client
#       name: dsh-pc-manager

# 3. 重启 dsh web
```

## 功能

### 模型工具

| 工具 | 功能 | 状态 |
| --- | --- | --- |
| `pc_status` | 只读系统快照：CPU/GPU 使用率、负载、温度（能力门控）、内存分解（含 swap）、磁盘 I/O 与各卷占用、电池/电源、网络计数器、多键排序进程表（macOS + Linux + Windows；Windows 无负载均值、进程级网络与磁盘列不可得，见[Windows 数据来源](#windows-数据来源)） | ✅ 已实装 |
| `pc_junk_scan` | 枚举可回收垃圾（macOS：废纸篓、用户缓存/日志、系统临时、Xcode 产物、模拟器残留、包管理器缓存、iOS 备份；Linux：XDG 回收站、~/.cache、/tmp 与 /var/tmp、包管理器缓存；Windows：账户回收站、%TEMP% 与 %SystemRoot%\Temp、WER 报告与崩溃转储、WinINet/D3D/NVIDIA 着色器/RDP 缓存、包管理器缓存），逐项体积/安全标记/保护排除记录；参数 `kinds` / `minItemBytes`；永远 dry-run | ✅ 已实装 |
| `pc_junk_clean` | 按 scan 返回的精确 id 回收；结构校验链（格式/根包含/realpath/blocked/safeToClean）任一失败整体拒绝零删除；`trash` kind 原地清空、其余默认三级 trash（macOS：`/usr/bin/trash` → rename `~/.Trash` → 跨卷 cp+rm；Linux：`trash-put`/`gio trash` → freedesktop `~/.local/share/Trash/{files,info}` 带 `.trashinfo` 还原记录 → 跨卷 cp+rm；Windows：`Microsoft.VisualBasic` 回收 API 进**真实回收站** → 退回 `%LOCALAPPDATA%\pc-manager\trash` → 跨卷 cp+rm）；量不准不删；tier-1 报成功但来源仍在则判定失败并降级；需配置显式开启 | ✅ 已实装 |
| `pc_apps_list` | 已装应用清单（app bundle + Homebrew；Linux 发行版包与 Windows 注册表程序待 M3），含大小/最近使用 | 桩，M3 |
| `pc_app_uninstall` | 按精确 id 卸载；默认移入废纸篓，残留项报告而非静默删除 | 桩，M3 |

### 仪表盘（右侧边栏）

web profile 的右侧边栏"系统监控"入口（order 30），点开是窄列卡片仪表盘：
头部（主机/系统 + 次行"本机 … · 公网 IP·城市"（归属地仅城市；查询关闭或未命中时该段
收缩）/运行时长）→ CPU（条+负载+温度行*+sparkline）→ GPU（取不到整卡隐藏）→
内存（swap+分解）→ 磁盘（有效卷用量条 + I/O 速率）→ 电池（无电池隐藏）→ 网络（主接口
速率+sparkline）→ 进程表（按 CPU/内存/网络切换，默认前 10；CPU 列表头悬停显示口径说明）。
手写 SVG，无图表库。

- **能力门控行/列**：CPU 卡温度行（Linux 有传感器 / Windows 有 ACPI 热区才出现）、负载行
  （Windows 无负载均值，整行隐藏而不是摆 0）、GPU 卡与进程表"GPU"列（Windows 用厂商无关的引擎
  计数器，AMD/Intel/NVIDIA 都能出；Linux 需 NVIDIA 硬件 + `nvidia-smi`）、进程表"网络"列
  （macOS nettop 恒有；Linux root `ss -tinp` 归因才出现；Windows 需 ETW，恒隐藏）
  ——缺能力即隐藏、不摆"—"墙，详见[能力门控探针](#能力门控探针)。磁盘卡在 Windows 上按盘符列出
  每个卷（`C:\`、`Z:\`……），POSIX 侧仍是 `/` 与 `/Volumes`、`/media`、`/mnt` 下的数据卷。
  进程 CPU% 为**单核口径**（多核进程可超 100%）且为**进程生命周期平均**（macOS/Linux 来自 ps，
  Windows 由 `Get-Process` 的累计 CPU 时间除以进程存活时间算得），表头 tooltip 有说明。
- 数据走同进程 host 半的**单一采集泵 + SSE 推送**：`GET /pc-manager/stream`（text/event-stream）
  是共享基座——host 侧一个定时器（间隔 `dashboardPollMs`，可调 min 500）单路采集并做服务端
  差分（网络速率首帧即有），仪表盘与悬浮窗等所有消费者共享同一条连接、同一帧数据；**无消费者
  时连接与采集自动停止**（引用计数，tab 隐藏/悬浮窗关闭即释放）。`GET /pc-manager/status`
  （`?processSort=&processLimit=`）保留为缓存兜底：与泵同排序（默认 CPU）的请求直接读新鲜
  缓存，其他排序现场采集。LLM 工具 `pc_status` 不经泵、契约不变。
- headless profile（无 webServer）自动跳过路由注册，工具不受影响。GPU 卡在有来源时以**适配器名**作标题
（Windows 从显示适配器读，如 `AMD Radeon(TM) Vega 8 Graphics`；窄列会用省略号截断，完整名在 tooltip 里），
没有名字来源的平台仍显示通用 `GPU`。

### 垃圾清理（零 LLM 直执行窗口）

右侧边栏**独立"垃圾清理"窗口**（guide 入口与系统监控平级，order 31），**全程零 LLM**：
点击"扫描"→ host `GET /pc-manager/junk/scan`（只读，服务端按 1 MiB 阈值过滤小项）→ 按**类别**
呈现（勾选单位是类别而非单项；行内预览体积 Top 2–3 项名回答"影响了哪些应用"；每类"明细 (N)"
折叠展开为滚动列表供手术式增删；推荐类别预勾选——不可再生的 Xcode 归档/iOS 备份与
`safeToClean:false` 的 pnpm store/模拟器残留默认不选并注明原因）→"清理已选"→ **就地两步确认条**
（N 项 · 体积 → 废纸篓（可恢复）/永久删除）→ `POST /pc-manager/junk/clean` 直执行 → **就地简报**。
宿主侧与工具路径共用同一 config 闸门与 id 校验链（整体拒绝零删除），并输出审计日志行；确认条
不可跳过，替代工具路径的审批面板。**悬浮窗"扫描"按钮唤起该窗口并自动开始扫描**
（`openTab` + navigation revision，重复唤起即重扫）；五工具与安全防御不变。

**注意**：对话路径的审批面板只在会话 Access mode 的审批策略为 ask 时出现；部署默认预设为
danger-full-access（`approval: never`）时会话内 ask 被静默自动拒绝，需在会话里切换 Access mode
或调整部署预设。UI 直执行窗口不受此限。

## 安全设计

- **只读工具开箱即用**；两个破坏性工具默认 `disabled_by_config`，宿主在后层 patch 把开关置
  true 才会真正动手。
- 回收/卸载默认走**废纸篓**（可恢复；Windows 上即系统"回收站"，两句在本文档中同义）；永久删除需
  `moveToTrash: false`。trash 落地三级：
  macOS 为 `/usr/bin/trash`（绝对路径调用，防 PATH 劫持）→ 归属校验后的 `~/.Trash` rename（名冲突加
  ` 2`/` 3` 后缀）→ 跨卷 EXDEV 时 cp+rm；Linux 为 `trash-put`/`gio trash`（探测式绝对路径）→
  freedesktop `~/.local/share/Trash/{files,info}` rename + **`.trashinfo` 还原记录**（双面名冲突
  同步后缀）→ 跨卷 cp+rm；Windows 为 `Microsoft.VisualBasic.FileIO.FileSystem` 的
  `SendToRecycleBin`（= 资源管理器同款 shell 回收，落**真实回收站**并记录原位置，可从资源管理器还原；
  路径以 PowerShell 字面量**内嵌进脚本**而非追加 argv——`-Command` 会用空格重新拼接参数，带空格的
  路径会被拆成两个参数，多行脚本更是完全收不到 `$args`）→ 退回 `%LOCALAPPDATA%\pc-manager\trash`
  （profile 内的私有保留区，仍可恢复，只是不在回收站 UI 里）→ 跨卷 cp+rm。tier-1 报成功后**再确认
  来源确实消失**，否则判失败并降级——静默 no-op（shell API 被策略挡下、参数没绑上）绝不能被当成
  "已回收 N 字节"上报（Windows 的 E2E 正是这样先抓到了一次假成功）。
  `trash` kind 本身原地清空（macOS 清空 `~/.Trash`、Linux 清 `files/`+`info/` 内容、Windows 清空本
  账户的 `%SystemDrive%\$Recycle.Bin\<SID>`——那正是"清空回收站"对该卷的语义）。
  搬回废纸篓是无意义的套娃。
- **垃圾清理三层确认**：模型对话确认（工具 description 指引优先 `ask_user_question`）+ 框架
  `tools/pre-execute` 审批闸门（`askBeforeJunkClean` 默认 true，每次必问、无 answerer
  fail-closed）+ id 结构校验链（children 类严格子路径 / whole 类恰为根、双侧 realpath 防符号
  链接重定向、blocked 清单、safeToClean；任一失败**整体拒绝零删除**）。
- **安全目标注册表**是核心资产：macOS 18 类 / 19 行、Linux 11 类 / 12 行（XDG）、Windows 11 类 /
  18 行（`%VAR%` 根），含敏感缓存保护清单（密码管理器/IDE/输入法/VPN/同步盘/AI 应用的"缓存"实为
  不可再生状态，命中记入 `skipped` 不出 item）与 EDR/活跃服务前缀保护（企业安全代理缓存删除会触发
  防篡改告警；Linux 侧另护 `systemd-private-*`、`snap-private-tmp`；Windows 侧护 AV/EDR 目录与
  安装器脚手架）；`safeToClean:false` 条目只报告不清理，rationale 带建议命令
  （`xcrun simctl delete unavailable` / `pnpm store prune`）。
- **id 校验用字面量自身的路径风味**：Windows 路径大小写不敏感、以盘符为根，POSIX 路径区分大小写；
  校验链（根包含 / 相等 / blocked）全部按该路径的风格归一化与比较，因此同一套代码既能校验
  `C:\Users\t\AppData\Local\Temp\x`，也能校验 `/home/t/.cache/x`。
- 领域模块（`src/monitor.ts`、`junk.ts`、`apps.ts`、`win32.ts`）不依赖 cordis，纯逻辑可独立单测。

## 附录

### 监控指标与数据来源

所有探针按平台分派、失败降级为 null/空值 + `console.warn`，不炸快照。Linux 基础指标全部读
`/proc` 与 `/sys`，零依赖零提权；**能力检测增强**（进程网络归因、温度、进程级 GPU）遵循
"检测到能力才启用，缺能力静默 null、不刷 warn"——见下表与[能力门控探针](#能力门控探针)。

| 分组 | 指标 | macOS 来源 | Linux 来源 | 解析器 |
| --- | --- | --- | --- | --- |
| CPU | 使用率 % | `os.cpus()` 两次采样 250ms 差分 | 同左（采样窗口 ≥1s，见磁盘 I/O） | `cpuUsagePercent` |
| CPU | 型号/核数/负载 1/5/15 | `node:os` | `node:os` | — |
| CPU | 封装温度 °C | null（`powermetrics` 需 sudo，不代跑） | `/sys/class/hwmon`（name+`temp*_input` 毫度）回退 `/sys/class/thermal`（type+temp）；CPU 系芯片取最大；云主机常无传感器 → null | `pickCpuTempCelsius` / `isCpuTempSource` |
| GPU | 使用率 %（尽力而为） | `ioreg -r -d 1 -c IOAccelerator` 的 `Device Utilization %`，多 GPU 取最大 | `nvidia-smi --query-gpu=utilization.gpu`（二进制在场缓存探测；无 NVIDIA 硬件则 null，UI 整卡隐藏） | `parseIoregGpu` / `parseNvidiaSmiGpu` |
| 内存 | macOS: used = active+wired+compressed（回退 total−free）；Linux: used = MemTotal−MemAvailable（回退 total−free−buffers−cached） | `vm_stat`（页大小从头部解析） | `/proc/meminfo`（app≈AnonPages，wired≈SUnreclaim，cached=Buffers+Cached+SReclaimable） | `parseVmStat` / `parseMeminfo` |
| 内存 | swap 总量/已用 | `sysctl -n vm.swapusage` | `/proc/meminfo` 的 SwapTotal/SwapFree | `parseSwapUsage` / `parseMeminfo` |
| 磁盘 | 各卷占用 | `df -k` | `df -k`（解析兼容两种列布局；过滤 tmpfs/udev/overlay/squashfs 等伪文件系统与 /dev /proc /sys /run /snap 挂载点） | `parseDf` |
| 磁盘 | I/O 吞吐（读+写合计） | `iostat -d -c 2` 末样本求和 | `/proc/diskstats` 双采样差分（物理整盘 sd/nvme/vd/hd/mmcblk，排除分区与 loop/dm；采样窗口拉到 1s） | `parseIostat` / `parseDiskstats` + `diskstatRate` |
| 电池 | 电量/充电/剩余时间/循环/健康度 | `pmset -g batt` + `ioreg -rn AppleSmartBattery` | `/sys/class/power_supply/BAT*/uevent`（AC 从 `A*/online`；无电池隐藏卡片） | `parsePmsetBatt` / `parseIoregBattery` / `parseBatteryUevent` |
| 网络 | 各接口累计 rx/tx（速率由调用方差分） | `netstat -ib`（排除 lo*，`<Link#>` 行去重） | `/proc/net/dev`（排除 lo） | `parseNetstatIb` / `parseProcNetDev` |
| 网络 | 本机 IPv4 | `node:os` `networkInterfaces()`（非 internal、排除 `169.254.*` 链路本地；**三平台同源，win32 亦可用**） | 同左 | `pickLocalAddresses` |
| 网络 | 公网 IP 及归属地（可关） | ipwho.is HTTPS 查询（`enableIpGeoLookup` 默认开；成功缓存 `ipGeoRefreshMinutes`（默认 30min、min 5），失败负缓存 60s；端点可经 `ipGeoEndpoint` 替换为兼容镜像） | 同左 | `parseIpWhoIs` / `createIpGeoLookup` |
| 进程网络 | **仪表盘/SSE 帧：实时速率**；**`pc_status` 工具：累计值**——两口径各自成立 | `nettop` 累计 + pump 差分 | **root 时** `ss -tinp` socket 归因（TCP 口径：当前打开 socket 的 bytes_received/bytes_sent 求和；非 root 整列 null 隐藏） + pump 差分 | `parseNettop` / `parseSsTinp` / `diffProcessRates` |
| 进程 GPU | SM 利用率 % | null（无来源） | `nvidia-smi pmon -c 1` 按 pid 归因（多 GPU 取最大；无二进制/无占用进程则列隐藏） | `parseNvidiaSmiPmon` / `mergeGpuPercent` |
| 系统 | 系统版本 | `sw_vers -productVersion` | `/etc/os-release` PRETTY_NAME（如 `Debian GNU/Linux 12 (bookworm)`） | `parseSwVers` / `parseOsRelease` |
| 进程 | CPU%/内存%(+rss)/网络累计/GPU%；磁盘列预留恒 null | `ps -Ao pid,pcpu,pmem,rss,comm` + `nettop`（CSV/JSON 双兼容） | `ps -Ao pid,pcpu,pmem,rss,args`（Linux comm 截断 15 字符，改用 args）+ `ss -tinp`（root）+ `pmon` | `parsePs` / `parseNettop` / `parseSsTinp` / `mergeProcesses` / `mergeGpuPercent` / `sortProcesses` |

### Windows 数据来源

Windows 既没有 `/proc` 也没有 `df`/`ps`，因此策略是**node 内建扛热字段 + 单次批量 PowerShell 探针
补其余**：一个 `powershell.exe -NoProfile -NonInteractive -NoLogo -Command` 进程一次取回全部
（卷、内存分解、网卡计数、磁盘吞吐、电池、温度、进程表），原因是**解释器启动占绝对大头**
（在有终端安全软件的机器上冷启动 ~2.3 s，每条 WMI 查询只多 30–700 ms），而并发的第二个
解释器进程本身会污染它正在采集的进程表——脚本把自己的 `$PID` 一并上报，解析侧据此丢掉该行。

| 分组 | 指标 | Windows 来源 | 解析器 |
| --- | --- | --- | --- |
| CPU | 使用率/型号/核数 | `node:os`（`os.cpus()` 差分） | `cpuUsagePercent` |
| CPU | 负载 1/5/15 | **null**（Windows 无负载均值；`os.loadavg()` 恒返回 0，那不是"空闲"而是"没有这个数"，仪表盘隐藏该行） | — |
| CPU | 封装温度 °C | `root\WMI` `MSAcpi_ThermalZoneTemperature`（0.1 K → °C，多次读数取最大；通常需提权、台式机常无此类 → null，能力门控） | `parseWindowsBundle` |
| GPU | 使用率 % + 适配器名 | `Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine`——**厂商无关**的引擎计数器（AMD/Intel/NVIDIA 通吃，不像 `nvidia-smi` 只认一家）；整卡口径取**最忙引擎**（该引擎各进程之和，clamp 100，与任务管理器同口径）。适配器名另取 `Win32_VideoController.Name`（如 `AMD Radeon(TM) Vega 8 Graphics`，仪表盘卡片标题）。缺该类时回退 `nvidia-smi --query-gpu`（二进制在场缓存探测） | `parseWindowsGpuEngines` |
| GPU | 进程级使用率 % | 同一份引擎计数器按 `pid_<pid>_…_engtype_<type>` 归属到进程（该进程所有引擎实例求和，clamp 100 = 任务管理器"进程"页那一列）；缺该类时回退 `nvidia-smi pmon` | `parseWindowsGpuEngines` / `mergeGpuPercent` |
| 内存 | total/used | node 内建 `os.totalmem()`/`os.freemem()`（后者即 `GlobalMemoryStatusEx` 的"可用"，含 standby，等价 MemAvailable） | — |
| 内存 | app/wired/cached/swap 分解 | `Win32_PerfFormattedData_PerfOS_Memory`（`AvailableBytes`/`StandbyCacheNormalPriorityBytes`/`PoolNonpagedBytes`/`CommittedBytes`）+ `Win32_PageFileUsage`（页面文件当 swap）；compressed/purgeable 无计数器 → null | `parseWindowsBundle` |
| 磁盘 | 各卷占用 | `Win32_LogicalDisk`（DriveType 2/3/4，`Size`/`FreeSpace`/`FileSystem`；`mount` 为盘符根 `C:\`） | `parseWindowsVolumes` |
| 磁盘 | I/O 吞吐 | `Win32_PerfFormattedData_PerfDisk_PhysicalDisk` 的 `_Total` `DiskBytesPersec`（免等待，比 `Get-Counter` 省一次 1 s 采样） | `parseWindowsBundle` |
| 网络 | 各接口累计 rx/tx | `Win32_PerfRawData_Tcpip_NetworkInterface`（`…Persec` 是性能计数器命名惯例，值是自启动累计；排除 Loopback/isatap/Teredo/Pseudo；重复实例保留 `_2` 后缀） | `parseWindowsNetwork` |
| 电池 | 电量/充电/电源/剩余时间 | `Win32_Battery`（`BatteryStatus` 2/6/7/8/9/11 = 接电，6–9/11 = 充电中，`powerSource` 复用 macOS 的 `AC Power`/`Battery Power` 字面量；`EstimatedRunTime` 哨兵 71582788 → null）；循环次数/健康度需厂商 WMI 或 `powercfg /batteryreport` → null | `parseWindowsBattery` |
| 系统 | 系统版本 | `os.version()` + `os.release()`（如 `Windows 11 Pro for Workstations 10.0.26300`；PowerShell 缺席也拿得到），探针在手时用 `Win32_OperatingSystem` 的 Caption 覆盖 | `windowsOsVersion` |
| 进程 | CPU%/内存%/命令 | `Get-Process`：`cpuPercent = CPU 累计秒 / (now − StartTime) × 100`（**单核口径、进程生命周期平均**，与 ps 语义一致所以排名可跨平台比较；受保护进程读不到 `StartTime`/`CPU` → 0），`memPercent = WorkingSet64 / totalmem`，命令取 `Path`（读不到则回退进程名） | `parseWindowsProcesses` |
| 进程 | 网络列 | **null，列整列隐藏**——这是 Windows 上唯一补不上的指标：按进程的字节归因需要 ETW 内核网络会话（任务管理器显示该列也是因为它默认以管理员令牌运行），没有零提权来源；全局速率仍由"网络"卡片按接口给出 | — |

**轮次成本与仪表盘节奏**：一次 Windows 采集 = 1 个 PowerShell 进程（~2.5–4.5 s，取决于机器的
安全软件）+ node 内建（~10 ms）+ 可选的 `nvidia-smi`；pump 会跳过重叠轮次，因此即使
`dashboardPollMs` 设为 500，Windows 上的实际刷新节奏也就是一轮的耗时（这是平台事实，不做静默
改写配置）。探针缺席（无 PowerShell）时快照仍可用：CPU/内存总量/运行时长/系统版本全部来自
node 内建，只有体积、进程表、电池等细节为空。

### 能力门控探针

"检测到能力才启用"的增强（失败不重试探测、不刷 warn，能力缺失即整列/整行 null，UI 相应隐藏）：

| 探针 | 门控 | 语义与边界 |
| --- | --- | --- |
| 进程网络归因 `ss -tinp` | `process.getuid() === 0` | root 下 `ss -p` 才能归属**全部** socket；非 root 只见自家进程，宁可整列不展示。TCP 口径、当前 socket 求和（socket 关闭计数归零，差分窗口自动丢弃该 pid 的速率，不会出负值/假速率） |
| 温度 hwmon/thermal_zone | 无需特权，传感器在场即读 | CPU 系芯片名（coretemp/k10temp/zenpower/cpu_*/acpitz/x86_pkg_temp/soc_*）取最大读数；nvme/amdgpu 等不计入；云主机无传感器 → null（CPU 卡温度行隐藏） |
| 进程 GPU `nvidia-smi pmon` | 二进制在场（`/usr/bin`、`/usr/local/bin` 缓存探测一次） | SM 利用率按 pid 归因；`-` 占位行跳过；多 GPU 取最大。无 NVIDIA 硬件的主机探测一次后永不 spawn |
| Windows 全量探针（PowerShell 包） | `powershell.exe` 在场（`%SystemRoot%\System32\WindowsPowerShell\v1.0`，缓存探测一次，`pwsh` 7 为备选） | 缺席时降级为 node 内建的"最小快照"（CPU/内存总量/运行时长/系统版本仍在），体积/进程表/电池/网络为空；包内每个字段各自降级（WMI 类缺失或需提权 → null） |
| Windows GPU 引擎计数器 | `Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine` 类在场（`-ErrorAction Stop` 探测一次；Windows 10 1709+ 有显示适配器即有） | 厂商无关的整卡 + **进程级** GPU 利用率（同一份数据两个口径），并带 `Win32_VideoController` 的适配器名给卡片标题。缺类 → GPU 卡与 GPU 列隐藏，回退 `nvidia-smi`（若在场）。**0% 是"测到的空闲"，null 才是"没有这个能力"** —— 空闲的核显照样出卡片 |
| Windows 封装温度 | `root\WMI` `MSAcpi_ThermalZoneTemperature` 有读数 | 常见于笔记本且常需提权；台式机/受限环境无此类 → null，CPU 卡温度行隐藏 |
| Windows 进程级网络 | 无来源（需 ETW 内核会话 / 提权 helper） | 网络列整列隐藏，不用 0 伪造；全局速率仍在"网络"卡 |
| Windows `nvidia-smi`（回退） | `System32`、`NVIDIA Corporation\NVSMI` 或 PATH 在场缓存探测 | 仅在引擎计数器不可用时才 spawn；与 Linux 同一套解析器（整卡 `--query-gpu` + 进程级 `pmon`） |

### 垃圾目标注册表（按平台分派）

注册表结构跨平台共享（`JunkTarget`），条目按平台分派（`JUNK_TARGETS_BY_PLATFORM`）：
`JUNK_TARGETS_DARWIN`（18 类 / 19 行）与 `JUNK_TARGETS_LINUX`（11 类 / 12 行，XDG 布局）、
`JUNK_TARGETS_WIN32`（11 类 / 18 行，`%VAR%` 根）；`JUNK_KINDS` 封闭词表三平台不变（schema 稳定），
平台专属类（user-logs 在 Linux 侧、Xcode/模拟器族与 ios-backups 在 Linux/Windows 侧、
homebrew-cache 在 Windows 侧）无条目。

**路径风味层**：注册表同时承载 POSIX 与 Windows 字面量，而测试套件在任一主机上都要 pin 三张表，
因此路径变换一律**按字面量自身的风味**选择 `path.posix`/`path.win32`（`pathFlavor`/`normalizePath`/
`joinPath`/`isAbsolutePath`/`basenamePath`），而不是按宿主默认——否则在 Windows 上跑测试会把
POSIX fixture 改写成 `\Users\t\.Trash`。归一化会去掉尾部分隔符（根除外）：`user-caches:/x/.cache/`
是根自身，不能被当作"根的子项"放行（否则尾斜杠可以清空整个注册表根）。

| Linux 类别 | 目录 | 粒度 | minAge | safe |
| --- | --- | --- | --- | --- |
| `trash` | `~/.local/share/Trash` | whole | — | ✅ |
| `user-caches` | `~/.cache`（含 thumbnails） | children（`LINUX_PROTECTED_CHILDREN` 保护） | — | ✅ |
| `system-temp` ×2 | `/tmp`、`/var/tmp` | children（`systemd-private-*`、`snap-private-tmp`、Linux EDR 前缀保护） | 3 天 | ✅ |
| `npm-cache` / `pnpm-store` / `homebrew-cache` | `~/.npm/_cacache` / `~/.local/share/pnpm/store`（❌ 建议 `pnpm store prune`）/ `~/.cache/Homebrew` | whole / children / children | — | ✅ / ❌ / ✅ |
| `pip-cache` / `uv-cache` / `yarn-cache` / `go-build-cache` / `go-mod-cache` | `~/.cache/{pip,uv,yarn,go-build}`、`~/go/pkg/mod/cache` | whole | — | ✅ |

| Windows 类别 | 目录 | 粒度 | minAge | safe |
| --- | --- | --- | --- | --- |
| `trash` | `%SystemDrive%\$Recycle.Bin` | children（每账户 SID 一个；`WINDOWS_SYSTEM_SIDS` 保护 LocalSystem/LocalService/NetworkService） | — | ✅ |
| `system-temp` ×2 | `%TEMP%`、`%SystemRoot%\Temp` | children（`WINDOWS_TEMP_PROTECTED` 保护） | 3 天 | ✅ |
| `user-logs` ×3 | `%LOCALAPPDATA%\…\WER\{ReportArchive,ReportQueue}`、`%LOCALAPPDATA%\CrashDumps` | children | — | ✅ |
| `user-caches` ×5 | `INetCache`、`D3DSCache`、`NVIDIA\{DXCache,GLCache}`、`Terminal Server Client\Cache` | children | — | ✅ |
| `npm-cache` / `pnpm-store` | `%LOCALAPPDATA%\npm-cache` / `%LOCALAPPDATA%\pnpm\store`（❌ 建议 `pnpm store prune`） | whole / children | — | ✅ / ❌ |
| `pip-cache` / `uv-cache` / `yarn-cache` / `go-build-cache` / `go-mod-cache` | `%LOCALAPPDATA%\{pip\Cache,uv\cache,Yarn\Cache,go-build}`、`%USERPROFILE%\go\pkg\mod\cache` | whole | — | ✅ |

**Windows 没有 `user-caches` 伞形行**（刻意）：`%LOCALAPPDATA%` 不是 `~/.cache` 那种缓存目录，
它混着真实的应用状态（`Packages\*\LocalState`、`Microsoft\Credentials`、浏览器 profile），
没有一份保护清单能可靠覆盖，因此只登记逐个已知安全的缓存根。同理 `$Recycle.Bin` 用 children
粒度按账户 SID 分行：别的账户的 SID 目录读不到（降级为 `skipped`），系统账户 SID 由保护清单挡下。

**命令式回收不进注册表**（延续设计文档 §14）：`apt-get autoremove --purge`（先 `-s` 模拟）、
`journalctl --vacuum-size=`、snap 旧版本（`snap list --all` 的 disabled 行 → `snap remove
--revision`）、`flatpak uninstall --unused`、`docker system prune`、Windows 的
`Dism /Online /Cleanup-Image /StartComponentCleanup`（WinSxS 组件清理）、
`SoftwareDistribution\Download`（Windows Update 缓存，需停 `wuauserv`）与 Storage Sense 只作为
建议命令报告，不做执行路径。

**blocked 红线清单**（三平台并集，防未来注册表误配）：macOS 侧 `/System`、`/usr`、`/private/var/db`、
`~/Library/Containers` 等原样保留；Linux 侧 `/etc`、`/boot`、`/var/log`、`/var/lib`（含 dpkg/snapd/
flatpak 状态）、`/var/cache`、`/lib*`（含运行中内核模块）、`/srv`；Windows 侧的清单**从环境推导**
（`SystemRoot`/`ProgramFiles`/`ProgramData`/`SystemDrive`，另有常规路径兜底），覆盖
`%SystemRoot%`、`Program Files`(+x86)、`ProgramData`、`Recovery`、`PerfLogs`、
`System Volume Information`、`Users\{Default,Public,All Users}`，并额外拒绝**盘符根**（`C:\`）与
`$HOME` 账户根下的其它账户树（大小写不敏感：Windows 文件系统不区分大小写）；
`$Recycle.Bin` 本身不在红线上——它是注册表根。
多用户 home 双布局（`/Users` 与 `/home`）下他人目录一律拒绝，`/root` 在非 $HOME 时同样拒绝。

### 反向代理 / 前缀挂载部署

浏览器侧全部请求（SSE 与 JSON）走**文档相对路径**（`pc-manager/…`，无前导 `/`），由 web shell
的 `<base href="./">` 解析——这是 harness 的既有约定（架构笔记 *web-document-relative-app-routes*，
与 `/plugins/events` 通道同规）。因此本插件**天然支持前缀剥除型反代挂载**（如
`https://host/dsh/` → 转发并剥前缀），也兼容源站根路径部署，无需二次构建。

SSE 流经反代时建议与 dsh 自身的 `/plugins/events` 同款配置，否则默认缓冲会延迟推帧、60s 默认
读超时会掐断长连接：

```nginx
location = /dsh/pc-manager/stream {
    proxy_pass http://127.0.0.1:3080/pc-manager/stream;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 24h;
    proxy_send_timeout 24h;
}
```

## 仓库结构

dual-face 包：host 半（工具 + 路由）与浏览器半都吃**已提交的构建产物 `lib/`**
（host `index.js` ESM，外部依赖经 dsh 运行时解析；client `client.js` 是
`window.__ModuleLoader__.load` 工件）：

```
├── src/
│   ├── index.ts       插件入口：Config（TS 接口 + Schemastery schema）+ apply；host 半含 webServer 路由
│   ├── monitor.ts     系统探针与纯解析器（macOS 子命令 + Linux /proc /sys + Windows 批量 PowerShell 包；不依赖 cordis，可独立单测）
│   ├── junk.ts        垃圾域：三平台安全注册表（darwin/linux/win32）、路径风味层、保护/封锁清单、走查、id 校验链、trash 三级
│   ├── win32.ts       Windows 平台设施：PowerShell 发现（缓存 promise，避免并发首调竞态）与容错 JSON 读取器
│   ├── apps.ts        应用域（M3 桩）
│   ├── types.ts       领域契约、PcManagerError、封闭错误词表 PcErrorCode
│   ├── tools.ts       唯一接触 defineTool 的注册层：guarded() 异常→封闭错误联合
│   └── client/        浏览器半：仪表盘 / 垃圾清理窗口 / 悬浮窗 / locale（值导入仅 react 系）
├── lib/               构建产物（已提交：host index.js + client client.js；*.map 忽略）
├── tests/             vitest：全部解析器 + 垃圾域全套（注册表逐条 pin、校验链逐层）
│                      + monitor.win32 / junk.win32（Windows 解析器与注册表，宿主无关）
│                      + e2e.win32（真实主机端到端：快照/扫描/真实回收站往返/HTTP 与工具面/构建产物）
├── scripts/           build / test / dev-setup（一键：链接 profile + 构建；跨平台解析 .bin/.cmd shim）
├── bundle.patch.yml   bundle 层（dsh.plugin add 时应用；安全默认，破坏性工具关闭）
├── cordis.patch.yml   开发 overlay（--patch 挂载，含本地 dogfooding 的开关配置）
├── tsdown.config.ts   双 entry 构建（host ESM + client CJS 工件契约）
├── tsconfig.json      类型检查专用（paths 双候选映射到并列/嵌套两种 harness 布局）
└── package.json       dsh-pc-manager（dsh.bundle + dsh.client + 真实 semver peer 范围）
```

## 本地开发

前置：本仓库与 [deepseek-harness](../deepseek-harness) **并列检出**（或嵌套在上一层的工作区
目录里，或用 `DSH_HARNESS_ROOT` 环境变量指认）。工具链（tsdown / vitest / tsc）全部借 harness
侧解析，本仓库**不要 `pnpm install`**，也没有任何 `node_modules`。

> **没有 harness 检出也能验证**：`scripts/test.mjs` 只要求 `DSH_HARNESS_ROOT` 指向一个含
> `package.json` 且装了 `vitest`/`tsc` 的目录，`tsconfig.json` 的 paths 也按同一套约定解析
> `@deepseek-ai/*`。因此可以自己搭一个"工具链替身"（`npm i vitest typescript @types/node
> @types/react react react-dom tsdown` + 按 `tsconfig.json` 里的嵌套路径做 junction），
> 本仓库的 Windows 支持就是这样验证的（tsdown 0.23 / vitest 3.2 / TypeScript 6.0，
> `@deepseek-ai/*` 取 0.2.0-rc.2 系列）。

一键 dev 安装（链接进 profile 的 node_modules + 构建产物，幂等）：

```sh
npm run dev-setup                # 默认 --profile web；或 node scripts/dev-setup.mjs --profile <name>
```

运行（在 harness 仓库根执行；host 半现在也吃 `lib/index.js`，改完 host 代码需重新 `npm run build`）：

```sh
cd ../deepseek-harness
pnpm dsh --patch ../dsh-pc-manager/cordis.patch.yml --profile web
```

测试与类型检查：

```sh
npm test                         # vitest（182 specs：176 通过 + 6 平台跳过）+ tsc --noEmit，均借 harness 二进制
```

**跨平台工具链说明**：`scripts/{build,test}.mjs` 在 Windows 上会自动改指 `.bin/<name>.cmd` 并以
`shell: true` 启动（`node_modules/.bin` 里的无扩展名 shim 在 Windows 上不可直接执行），
`scripts/dev-setup.mjs` 用 **junction** 代替目录符号链接（Windows 建符号链接需要开发者模式或提权）。
`tsc` 需要 TypeScript 6+：`tsconfig.json` 里的 `ignoreDeprecations: "6.0"` 在 5.x 上会直接报
`TS5103`。

覆盖全部纯解析器（df 双平台含 Linux 伪文件系统过滤/ps/vm_stat/meminfo/swapusage/os-release/
pmset/ioreg 电池与 GPU/nvidia-smi 整卡+pmon 进程级/iostat/diskstats 速率差分/netstat/net-dev/
nettop CSV+JSON/ss -tinp 归因/power_supply uevent/温度芯片选路/进程与 GPU 合并排序/CPU 差分）
与垃圾域全套（三平台注册表与保护清单逐条 pin、glob 展开、走查统计、scan 语义、校验链逐层含
符号链接重定向与尾斜杠根逃逸、整体拒绝、三平台 trash 三级（含 `.trashinfo` 还原记录与冲突后缀
同步）、blocked 红线并集、量不准不删、审批摘要 en/zh 快照），加上 Windows 专属解析器（
`Win32_LogicalDisk` 卷行、`PerfRawData_Tcpip_NetworkInterface` 网卡行、`Win32_Battery` 状态码与
`EstimatedRunTime` 哨兵、`Get-Process` 进程行与采样进程自剔除、包级降级）与 Windows 路径风味/
红线/校验用例。

**端到端（`tests/e2e.win32.spec.ts`）**——不注入任何东西：真实主机上跑 `collectStatus` 并断言快照
自洽（卷算术闭合、内存不超总量、本进程在进程表里、`loadavg` 为 null）；真实注册表只读扫描；
**真实回收站往返**（把一个 fixture 文件交给 shell 回收，再从 `$Recycle.Bin` 的 `$I`/`$R` 记录里把
它找出来验证原位置，然后只删这一条、不动用户既有回收站内容）；真实 delete 模式；用桩 cordis
上下文跑真实 `apply()` 并打 `/pc-manager/{status,junk/scan,junk/clean}` 四个面（含 405/400/403
拒绝路径）与五个工具；最后加载**已提交的 `lib/` 产物**（host 与 client 两个工件）核对契约——这条
会在源码改了但忘记 `npm run build` 时失败。权限降级（EACCES）用例需 POSIX 权限语义，root 或
Windows 上自动跳过（root 的 DAC override 读穿 0000 权限，Windows 的 `chmod` 只切只读属性、
挡不住读取）。

**link 安装（开发）的生效时机**：`install_bundle` 指向本地目录时以 `link:` 挂载——host 半在
安装/启停行时即时生效；浏览器半在**页面刷新**时取新 `lib/client.js`；但对**已在运行**的 dsh
进程改 host 代码后，Node 的 ESM 模块缓存不会因重载插件行而释放，host 半的新代码要等**下次
`dsh web` 重启**。因此 client 对新帧字段一律做 `typeof` 容错（如温度行），重启窗口期不会崩。

**发布约定**：改完源码必须 `npm run build` 并把 `lib/*.js` 一并提交——git 安装直接加载已提交
产物，不跑任何构建脚本（这也是免掉 pnpm ≥10 构建授权的方式）。构建工具链注意：`scripts/build.mjs`
以 `tsdown --config-loader native` 加载 TS 配置并自动加 `--experimental-strip-types`（tsdown 默认
的 unrun 配置加载器不是 harness 依赖，Node <23 也需要该 flag），无需手工干预。

## 里程碑

- **M0（完成）**：项目骨架 —— 类型契约、5 个工具 schema 与注册、插件入口、patch 清单；
  `pc_status` 基础版（node 内建 + `df`/`ps`）。
- **M1（完成，2026-10-05）**：`pc_status` 全量指标 —— `vm_stat` 精确内存、swap、电池/电源、
  GPU、磁盘 I/O、网络、macOS 版本、进程五指标表（GPU/磁盘列预留）；以及右侧边栏仪表盘
  （client 半 + webServer 路由 + 轮询）。
- **M2（完成，2026-10-06）**：垃圾扫描与清理实装 —— 18 类安全注册表 + 保护/封锁清单、
  dry-run 走查（并发 4、符号链接不跟随、EACCES 降级记 `skipped`）、id 校验链（整体拒绝零删除）、
  trash 三级、pre-execute 审批闸门（`askBeforeJunkClean`）。
- **M2.5（完成，2026-10-06）**：触发 UI —— 仪表盘动作卡 + 悬浮窗动作行 +
  `startSession` 种子草稿，共用 `cleanup.ts` 触发器。
- **M2.6（完成，2026-10-07）**：计划前置 —— 预置推荐计划（`RECOMMENDED_PLAN` 进域数据 + 测试
  pin）、host `GET /pc-manager/junk/scan` 只读路由、仪表盘计划卡、执行种子携带 ids；LLM 轮次 4→1。
- **M2.7（完成，2026-10-07）**：计划卡重组 + UI 直执行 —— 类别为选择单位（默认一屏 kind 行，
  明细折叠）、服务端 1 MiB 阈值过滤、`POST /pc-manager/junk/clean` 直执行（同一闸门与校验链 +
  就地两步确认 + 审计日志行 + 就地简报），仪表盘路径**零 LLM**。
- **M2.8（完成，2026-10-07）**：独立窗口 —— 垃圾清理升级为右侧边栏独立 tab（guide 入口与系统
  监控平级，order 30/31），悬浮窗"扫描"经 `sidebarRight.openTab` + autoScan 参数唤起窗口并自动
  扫描（重复唤起即重扫）；对话式种子路径退役。真实清理 e2e 三次验证（pip/npm/Homebrew 缓存 →
  废纸篓，字节吻合）。
- **M2.9（完成，2026-10-07）**：Linux 平台支持 —— 监控探针按平台分派（/proc/meminfo、/proc/net/dev、
  /proc/diskstats 双采样差分、/sys/class/power_supply、/etc/os-release、nvidia-smi 尽力而为、
  df 伪文件系统过滤、ps args 列）；垃圾注册表分平台（`JUNK_TARGETS_LINUX` 12 行 XDG 布局 +
  `LINUX_PROTECTED_CHILDREN`/`LINUX_TEMP_PROTECTED` 保护清单）；blocked 红线并集（/etc、/var/lib、
  /lib*、/boot 等）；trash 三级 Linux 落地（trash-put/gio trash → freedesktop `files/`+`info/`
  带 `.trashinfo` 还原记录 → 跨卷 cp+rm）；工具文案与仪表盘标签平台中性化；测试套件在
  Linux 与 macOS 双平台可绿（平台断言显式注入，root 环境跳过 EACCES 用例）。
- **M2.10（完成，2026-10-07）**：能力门控探针 —— Linux root 下 `ss -tinp` socket 归因补齐
  进程级网络（TCP 口径，速率经 pump 差分；非 root 整列隐藏）；`nvidia-smi pmon -c 1` 按 pid
  归因 SM 利用率（二进制在场缓存探测，缺席不 spawn 不刷 warn）；CPU 封装温度读
  `/sys/class/hwmon` 回退 `/sys/class/thermal`（CPU 系芯片取最大，`cpu.temperatureCelsius` 进
  schema 与 CPU 卡片）；`pc_status` description 同步。
- **M2.11（完成，2026-10-07）**：Windows 平台支持 —— 监控侧 node 内建扛热字段（CPU 差分、
  内存总量/可用、运行时长、`os.version()`+`os.release()` 系统名）+ **单次批量 PowerShell 探针**
  （`Win32_LogicalDisk` 卷、`PerfOS_Memory` 内存分解、页面文件当 swap、`PerfRawData_Tcpip_NetworkInterface`
  网卡、`PerfDisk_PhysicalDisk` 吞吐、`GPUPerformanceCounters_GPUEngine` 厂商无关 GPU 引擎
  （整卡"最忙引擎"口径 + 按 pid 归因的进程级 GPU，缺类回退 `nvidia-smi`）、`Win32_Battery`、
  `MSAcpi_ThermalZoneTemperature`、`Get-Process` 进程表，脚本自报 `$PID` 让采样进程从自己的进程表里
  消失）；`loadavg` 改为可空（Windows 无负载均值，仪表盘隐藏该行而不是显示假 0）；垃圾侧
  `JUNK_TARGETS_WIN32`（11 类 / 18 行 `%VAR%` 根，回收站按账户 SID 分行）与 Windows 红线（环境推导的
  系统目录 + 盘符根 + 他人账户树，大小写不敏感）；**路径风味层**（按字面量自身风格选 posix/win32，
  并顺带修掉 POSIX 侧尾斜杠可把注册表根当成"根的子项"清空的漏洞）；trash 三级 Windows 落地
  （真实回收站 → profile 私有保留区 → 跨卷 cp+rm）与 tier-1 结果复核；`scripts/*` 跨平台化
  （`.cmd` shim + junction）；新增 60 条 Windows 用例与 9 条真实主机 E2E（含回收站往返、GPU 能力
  一致性断言与 `lib/` 产物契约）。**唯一补不上的指标**是按进程网络归因（需 ETW 内核会话，无零提权
  来源），该列在 Windows 上按能力门控隐藏。
- **M3（规划中）**：应用清单与卸载 —— macOS `/Applications` bundle 走查（du + kMDItemLastUseDate）、
  `brew list` 合并、移废纸篓卸载、残留项（plist/`App Support`/缓存）报告；Linux 侧
  `dpkg-query` 清单与 `rc` 残留清理、Windows 侧注册表 Uninstall 键 + `%ProgramFiles%` 走查为后续候选。
- **未排期**：macOS 温度（`powermetrics` 需 sudo，不代跑）、进程级磁盘真实取数（需特权
  helper）、Windows 进程级网络归因（需 ETW）、pnpm store 引用计数感知清理、用户持久排除清单。

## License

[MIT](LICENSE)
