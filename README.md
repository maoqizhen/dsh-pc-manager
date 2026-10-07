# dsh-pc-manager — 电脑管家

> DSH plugin for system monitor and junk cleanup · 系统监控、垃圾清理与应用卸载的 DeepSeek Harness 插件

DeepSeek Harness (dsh) 的电脑管家插件（官方 bundle 格式），提供：系统状态监控（模型工具 +
右侧边栏仪表盘）、系统垃圾清理（零 LLM 直执行窗口）、软件卸载（M3），共 5 个模型可见工具。

**平台支持**：监控（`pc_status` + 仪表盘）与垃圾清理（`pc_junk_scan`/`pc_junk_clean` + 清理窗口）
在 **macOS 与 Linux** 上工作；其余平台返回 `unsupported_platform`。

定位是**安全第一**的 agent 系统工具：扫描永远 dry-run；破坏性工具默认 `disabled_by_config`，
宿主显式开启才动手；回收/卸载默认进废纸篓（可恢复）；id 校验链任一失败**整体拒绝零删除**。

## 安装（一行）

本仓库是官方 **bundle 插件**格式（根 `package.json` 的 `dsh.bundle` + `dsh.client`），
构建产物 `lib/` 已提交，git 安装无需任何构建步骤：

```sh
dsh plugin --profile web add "github:maoqizhen/dsh-pc-manager#main"
```

装完**重启 `dsh web`**（bundle 层在启动时合成）。更新 `dsh plugin --profile web update dsh-pc-manager`，
卸载 `dsh plugin --profile web remove dsh-pc-manager`，均需重启生效。

> **需要 pnpm**：`dsh plugin` 是 pnpm 转发器，PATH 里没有 pnpm 会直接失败
> （`npm i -g pnpm` 安装；pnpm 主版本需与 profile 现有 store 一致）。

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

## 工具一览

| 工具 | 功能 | 状态 |
| --- | --- | --- |
| `pc_status` | 只读系统快照：CPU/GPU 使用率、负载、内存分解（含 swap）、磁盘 I/O 与各卷占用、电池/电源、网络计数器、多键排序进程表（macOS + Linux） | ✅ 已实装 |
| `pc_junk_scan` | 枚举可回收垃圾（macOS：废纸篓、用户缓存/日志、系统临时、Xcode 产物、模拟器残留、包管理器缓存、iOS 备份；Linux：XDG 回收站、~/.cache、/tmp 与 /var/tmp、包管理器缓存），逐项体积/安全标记/保护排除记录；参数 `kinds` / `minItemBytes`；永远 dry-run | ✅ 已实装 |
| `pc_junk_clean` | 按 scan 返回的精确 id 回收；结构校验链（格式/根包含/realpath/blocked/safeToClean）任一失败整体拒绝零删除；`trash` kind 原地清空、其余默认三级 trash（macOS：`/usr/bin/trash` → rename `~/.Trash` → 跨卷 cp+rm；Linux：`trash-put`/`gio trash` → freedesktop `~/.local/share/Trash/{files,info}` 带 `.trashinfo` 还原记录 → 跨卷 cp+rm）；量不准不删；需配置显式开启 | ✅ 已实装 |
| `pc_apps_list` | 已装应用清单（app bundle + Homebrew），含大小/最近使用 | 桩，M3 |
| `pc_app_uninstall` | 按精确 id 卸载；默认移入废纸篓，残留项报告而非静默删除 | 桩，M3 |

### 垃圾目标注册表（按平台分派）

注册表结构跨平台共享（`JunkTarget`），条目按平台分派：`JUNK_TARGETS_DARWIN`（18 类 / 19 行）与
`JUNK_TARGETS_LINUX`（11 类 / 12 行，XDG 布局）；`JUNK_KINDS` 封闭词表跨平台不变（schema 稳定），
macOS 专属类（user-logs、Xcode/模拟器族、ios-backups）在 Linux 侧无条目。

| Linux 类别 | 目录 | 粒度 | minAge | safe |
| --- | --- | --- | --- | --- |
| `trash` | `~/.local/share/Trash` | whole | — | ✅ |
| `user-caches` | `~/.cache`（含 thumbnails） | children（`LINUX_PROTECTED_CHILDREN` 保护） | — | ✅ |
| `system-temp` ×2 | `/tmp`、`/var/tmp` | children（`systemd-private-*`、`snap-private-tmp`、Linux EDR 前缀保护） | 3 天 | ✅ |
| `npm-cache` / `pnpm-store` / `homebrew-cache` | `~/.npm/_cacache` / `~/.local/share/pnpm/store`（❌ 建议 `pnpm store prune`）/ `~/.cache/Homebrew` | whole / children / children | — | ✅ / ❌ / ✅ |
| `pip-cache` / `uv-cache` / `yarn-cache` / `go-build-cache` / `go-mod-cache` | `~/.cache/{pip,uv,yarn,go-build}`、`~/go/pkg/mod/cache` | whole | — | ✅ |

**命令式回收不进注册表**（延续设计文档 §14）：`apt-get autoremove --purge`（先 `-s` 模拟）、
`journalctl --vacuum-size=`、snap 旧版本（`snap list --all` 的 disabled 行 → `snap remove
--revision`）、`flatpak uninstall --unused`、`docker system prune` 只作为建议命令报告，不做执行路径。

**blocked 红线清单**（两平台并集，防未来注册表误配）：macOS 侧 `/System`、`/usr`、`/private/var/db`、
`~/Library/Containers` 等原样保留；Linux 侧 `/etc`、`/boot`、`/var/log`、`/var/lib`（含 dpkg/snapd/
flatpak 状态）、`/var/cache`、`/lib*`（含运行中内核模块）、`/srv`；多用户 home 双布局
（`/Users` 与 `/home`）下他人目录一律拒绝，`/root` 在非 $HOME 时同样拒绝。

## 系统监控指标与数据来源

所有探针按平台分派、失败降级为 null/空值 + `console.warn`，不炸快照。Linux 基础指标全部读
`/proc` 与 `/sys`，零依赖零提权；**能力检测增强**（进程网络归因、温度、进程级 GPU）遵循
"检测到能力才启用，缺能力静默 null、不刷 warn"——见下表与 [能力门控](#能力门控探针)。

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
| 进程网络 | **仪表盘/SSE 帧：实时速率**；**`pc_status` 工具：累计值**——两口径各自成立 | `nettop` 累计 + pump 差分 | **root 时** `ss -tinp` socket 归因（TCP 口径：当前打开 socket 的 bytes_received/bytes_sent 求和；非 root 整列 null 隐藏） + pump 差分 | `parseNettop` / `parseSsTinp` / `diffProcessRates` |
| 进程 GPU | SM 利用率 % | null（无来源） | `nvidia-smi pmon -c 1` 按 pid 归因（多 GPU 取最大；无二进制/无占用进程则列隐藏） | `parseNvidiaSmiPmon` / `mergeGpuPercent` |
| 系统 | 系统版本 | `sw_vers -productVersion` | `/etc/os-release` PRETTY_NAME（如 `Debian GNU/Linux 12 (bookworm)`） | `parseSwVers` / `parseOsRelease` |
| 进程 | CPU%/内存%(+rss)/网络累计/GPU%；磁盘列预留恒 null | `ps -Ao pid,pcpu,pmem,rss,comm` + `nettop`（CSV/JSON 双兼容） | `ps -Ao pid,pcpu,pmem,rss,args`（Linux comm 截断 15 字符，改用 args）+ `ss -tinp`（root）+ `pmon` | `parsePs` / `parseNettop` / `parseSsTinp` / `mergeProcesses` / `mergeGpuPercent` / `sortProcesses` |

### 能力门控探针

三项"检测到能力才启用"的增强（失败不重试探测、不刷 warn，能力缺失即整列/整行 null，UI 相应隐藏）：

| 探针 | 门控 | 语义与边界 |
| --- | --- | --- |
| 进程网络归因 `ss -tinp` | `process.getuid() === 0` | root 下 `ss -p` 才能归属**全部** socket；非 root 只见自家进程，宁可整列不展示。TCP 口径、当前 socket 求和（socket 关闭计数归零，差分窗口自动丢弃该 pid 的速率，不会出负值/假速率） |
| 温度 hwmon/thermal_zone | 无需特权，传感器在场即读 | CPU 系芯片名（coretemp/k10temp/zenpower/cpu_*/acpitz/x86_pkg_temp/soc_*）取最大读数；nvme/amdgpu 等不计入；云主机无传感器 → null（CPU 卡温度行隐藏） |
| 进程 GPU `nvidia-smi pmon` | 二进制在场（`/usr/bin`、`/usr/local/bin` 缓存探测一次） | SM 利用率按 pid 归因；`-` 占位行跳过；多 GPU 取最大。无 NVIDIA 硬件的主机探测一次后永不 spawn |

## 仪表盘（右侧边栏）

web profile 的右侧边栏"系统监控"入口（order 30），点开是窄列卡片仪表盘：
头部（主机/系统/运行时长）→ CPU（条+负载+sparkline）→ GPU（取不到整卡隐藏）→ 内存（swap+分解）→
磁盘（有效卷用量条 + I/O 速率）→ 电池（无电池隐藏）→ 网络（主接口速率+sparkline）→
进程表（按 CPU/内存/网络切换，默认前 10）。手写 SVG，无图表库。

- 数据走同进程 host 半的**单一采集泵 + SSE 推送**：`GET /pc-manager/stream`（text/event-stream）
  是共享基座——host 侧一个定时器（间隔 `dashboardPollMs`，可调 min 500）单路采集并做服务端
  差分（网络速率首帧即有），仪表盘与悬浮窗等所有消费者共享同一条连接、同一帧数据；**无消费者
  时连接与采集自动停止**（引用计数，tab 隐藏/悬浮窗关闭即释放）。`GET /pc-manager/status`
  （`?processSort=&processLimit=`）保留为缓存兜底：与泵同排序（默认 CPU）的请求直接读新鲜
  缓存，其他排序现场采集。LLM 工具 `pc_status` 不经泵、契约不变。
- headless profile（无 webServer）自动跳过路由注册，工具不受影响。

## 垃圾清理（零 LLM 直执行窗口）

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
- 回收/卸载默认走**废纸篓**（可恢复）；永久删除需 `moveToTrash: false`。trash 落地三级：
  macOS 为 `/usr/bin/trash`（绝对路径调用，防 PATH 劫持）→ 归属校验后的 `~/.Trash` rename（名冲突加
  ` 2`/` 3` 后缀）→ 跨卷 EXDEV 时 cp+rm；Linux 为 `trash-put`/`gio trash`（探测式绝对路径）→
  freedesktop `~/.local/share/Trash/{files,info}` rename + **`.trashinfo` 还原记录**（双面名冲突
  同步后缀）→ 跨卷 cp+rm；`trash` kind 本身原地清空（搬回废纸篓是无意义的套娃）。
- **垃圾清理三层确认**：模型对话确认（工具 description 指引优先 `ask_user_question`）+ 框架
  `tools/pre-execute` 审批闸门（`askBeforeJunkClean` 默认 true，每次必问、无 answerer
  fail-closed）+ id 结构校验链（children 类严格子路径 / whole 类恰为根、双侧 realpath 防符号
  链接重定向、blocked 清单、safeToClean；任一失败**整体拒绝零删除**）。
- **安全目标注册表**是核心资产：macOS 18 类 / 19 行、Linux 11 类 / 12 行（XDG），含敏感缓存保护
  清单（密码管理器/IDE/输入法/VPN/同步盘/AI 应用的"缓存"实为不可再生状态，命中记入 `skipped`
  不出 item）与 EDR/活跃服务前缀保护（企业安全代理缓存删除会触发防篡改告警；Linux 侧另护
  `systemd-private-*`、`snap-private-tmp`）；`safeToClean:false` 条目只报告不清理，rationale 带
  建议命令（`xcrun simctl delete unavailable` / `pnpm store prune`）。
- 领域模块（`src/monitor.ts`、`junk.ts`、`apps.ts`）不依赖 cordis，纯逻辑可独立单测。

## 仓库结构

dual-face 包：host 半（工具 + 路由）与浏览器半都吃**已提交的构建产物 `lib/`**
（host `index.js` ESM，外部依赖经 dsh 运行时解析；client `client.js` 是
`window.__ModuleLoader__.load` 工件）：

```
├── src/
│   ├── index.ts       插件入口：Config（TS 接口 + Schemastery schema）+ apply；host 半含 webServer 路由
│   ├── monitor.ts     系统探针与纯解析器（macOS 子命令 + Linux /proc /sys；不依赖 cordis，可独立单测）
│   ├── junk.ts        垃圾域：双平台安全注册表（darwin/linux）、保护/封锁清单、走查、id 校验链、trash 三级
│   ├── apps.ts        应用域（M3 桩）
│   ├── types.ts       领域契约、PcManagerError、封闭错误词表 PcErrorCode
│   ├── tools.ts       唯一接触 defineTool 的注册层：guarded() 异常→封闭错误联合
│   └── client/        浏览器半：仪表盘 / 垃圾清理窗口 / 悬浮窗 / locale（值导入仅 react 系）
├── lib/               构建产物（已提交：host index.js + client client.js；*.map 忽略）
├── tests/             vitest：全部解析器 + 垃圾域全套（注册表逐条 pin、校验链逐层）
├── scripts/           build / test / dev-setup（一键：链接 profile + 构建）
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
npm test                         # vitest（122 specs，root 环境自动跳过 4 个 EACCES 用例）+ tsc --noEmit，均借 harness 二进制
```

覆盖全部纯解析器（df 双平台含 Linux 伪文件系统过滤/ps/vm_stat/meminfo/swapusage/os-release/
pmset/ioreg 电池与 GPU/nvidia-smi/iostat/diskstats 速率差分/netstat/net-dev/nettop CSV+JSON/
power_supply uevent/进程合并排序/CPU 差分）与垃圾域全套（双平台注册表与保护清单逐条 pin、
glob 展开、走查统计、scan 语义、校验链逐层含符号链接重定向、整体拒绝、双平台 trash 三级
（含 .trashinfo 还原记录与冲突后缀同步）、blocked 红线并集、量不准不删、审批摘要 en/zh 快照）。
权限降级（EACCES）用例需非 root 运行器，root 下自动跳过（root 的 DAC override 读穿 0000 权限）。

**发布约定**：改完源码必须 `npm run build` 并把 `lib/*.js` 一并提交——git 安装直接加载已提交
产物，不跑任何构建脚本（这也是免掉 pnpm ≥10 构建授权的方式）。

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
- **M3（规划中）**：应用清单与卸载 —— macOS `/Applications` bundle 走查（du + kMDItemLastUseDate）、
  `brew list` 合并、移废纸篓卸载、残留项（plist/`App Support`/缓存）报告；Linux 侧
  `dpkg-query` 清单与 `rc` 残留清理为后续候选。
- **未排期**：macOS 温度（`powermetrics` 需 sudo，不代跑）、进程级磁盘真实取数（需特权
  helper）、Windows、pnpm store 引用计数感知清理、用户持久排除清单。

## License

[MIT](LICENSE)
