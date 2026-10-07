# dsh-pc-manager — 电脑管家

> DSH plugin for system monitor and junk cleanup · 系统监控、垃圾清理与应用卸载的 DeepSeek Harness 插件

DeepSeek Harness (dsh) 的电脑管家插件，住在 harness 仓库外部，通过 cordis patch 挂载：
系统状态监控（模型工具 + 右侧边栏仪表盘）、系统垃圾清理、软件卸载，暴露 5 个模型可见工具。

定位是**安全第一**的 agent 系统工具：扫描永远 dry-run；破坏性工具默认 `disabled_by_config`，
宿主显式开启才动手；回收/卸载默认进废纸篓（可恢复）；id 校验链任一失败**整体拒绝零删除**。

## 工具一览

| 工具 | 功能 | 状态 |
| --- | --- | --- |
| `pc_status` | 只读系统快照：CPU/GPU 使用率、负载、内存分解（含 swap）、磁盘 I/O 与各卷占用、电池/电源、网络计数器、多键排序进程表 | ✅ 已实装 |
| `pc_junk_scan` | 枚举可回收垃圾（废纸篓、用户缓存/日志、系统临时、Xcode 产物、模拟器残留、18 类包管理器缓存、iOS 备份），逐项体积/安全标记/保护排除记录；参数 `kinds` / `minItemBytes`；永远 dry-run | ✅ 已实装 |
| `pc_junk_clean` | 按 scan 返回的精确 id 回收；结构校验链（格式/根包含/realpath/blocked/safeToClean）任一失败整体拒绝零删除；`trash` kind 原地清空、其余默认三级 trash（`/usr/bin/trash` → rename `~/.Trash` → 跨卷 cp+rm）；量不准不删；需配置显式开启 | ✅ 已实装 |
| `pc_apps_list` | 已装应用清单（app bundle + Homebrew），含大小/最近使用 | 桩，M3 |
| `pc_app_uninstall` | 按精确 id 卸载；默认移入废纸篓，残留项报告而非静默删除 | 桩，M3 |

## 系统监控指标与数据来源

所有探针失败降级为 null/空值 + `console.warn`，不炸快照（温度需 sudo、进程级 GPU/磁盘需特权 helper，均明确不做）。

| 分组 | 指标 | 来源 | 解析器 |
| --- | --- | --- | --- |
| CPU | 使用率 % | `os.cpus()` 两次采样 250ms 差分 | `cpuUsagePercent` |
| CPU | 型号/核数/负载 1/5/15 | `node:os` | — |
| GPU | 使用率 %（尽力而为） | `ioreg -r -d 1 -c IOAccelerator` 的 `Device Utilization %`，多 GPU 取最大 | `parseIoregGpu` |
| 内存 | used = active+wired+compressed（回退 total−free）；app/wired/compressed/cached/purgeable | `vm_stat`（页大小从头部解析） | `parseVmStat` |
| 内存 | swap 总量/已用 | `sysctl -n vm.swapusage` | `parseSwapUsage` |
| 磁盘 | 各卷占用 | `df -k` | `parseDf` |
| 磁盘 | I/O 吞吐（读+写合计，无 sudo 拆不开） | `iostat -d -c 2` 末样本求和 | `parseIostat` |
| 电池 | 电量/充电/剩余时间/循环/健康度 | `pmset -g batt` + `ioreg -rn AppleSmartBattery` | `parsePmsetBatt` / `parseIoregBattery` |
| 网络 | 各接口累计 rx/tx（速率由调用方差分） | `netstat -ib`（排除 lo*，`<Link#>` 行去重） | `parseNetstatIb` |
| 进程网络 | **仪表盘/SSE 帧：实时速率**（服务端按 pid 记忆窗口差分，`processRates`）；**`pc_status` 工具：累计值**（单次调用无上下文，累计是唯一诚实口径）——两口径各自成立 | `nettop` 累计 + pump 差分 | `parseNettop` / `diffProcessRates` |
| 系统 | macOS 版本 | `sw_vers -productVersion` | `parseSwVers` |
| 进程 | CPU%/内存%(+rss)/网络累计；GPU/磁盘列预留恒 null | `ps -Ao pid,pcpu,pmem,rss,comm` + `nettop -P -L 1 -n -J bytes_in,bytes_out`（CSV/JSON 双兼容） | `parsePs` / `parseNettop` / `mergeProcesses` / `sortProcesses` |

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

- **只读工具开箱即用**；两个破坏性工具（`pc_junk_clean`、`pc_app_uninstall`）默认
  `disabled_by_config`，宿主在 patch 里把开关置 true 才会真正动手。
- 回收/卸载默认走**废纸篓**（可恢复）；永久删除需 `moveToTrash: false`。trash 落地三级：
  `/usr/bin/trash`（绝对路径调用，防 PATH 劫持）→ 归属校验后的 `~/.Trash` rename（名冲突加
  ` 2`/` 3` 后缀）→ 跨卷 EXDEV 时 cp+rm；`trash` kind 本身原地清空（搬回废纸篓是无意义的套娃）。
- **垃圾清理三层确认**：模型对话确认（工具 description 指引优先 `ask_user_question`）+ 框架
  `tools/pre-execute` 审批闸门（`askBeforeJunkClean` 默认 true，每次必问、无 answerer
  fail-closed）+ id 结构校验链（children 类严格子路径 / whole 类恰为根、双侧 realpath 防符号
  链接重定向、blocked 清单、safeToClean；任一失败**整体拒绝零删除**）。
- **安全目标注册表**是核心资产：18 类 / 19 行根，含敏感缓存保护清单（密码管理器/IDE/输入法/
  VPN/同步盘/AI 应用的"缓存"实为不可再生状态，命中记入 `skipped` 不出 item）与 EDR 前缀保护
  （企业安全代理缓存删除会触发防篡改告警）；`safeToClean:false` 条目只报告不清理，rationale 带
  建议命令（`xcrun simctl delete unavailable` / `pnpm store prune`）。
- 领域模块（`src/monitor.ts`、`junk.ts`、`apps.ts`）不依赖 cordis，纯逻辑可独立单测。

## 仓库结构

本仓库根即插件包根（`@deepseek-ai/dsh-pc-manager`，dual-face：host 半吃 TS 源码，
浏览器半吃构建产物 `lib/client.js`）：

```
├── src/
│   ├── index.ts       插件入口：Config（TS 接口 + Schemastery schema）+ apply；host 半含 webServer 路由
│   ├── monitor.ts     系统探针与纯解析器（不依赖 cordis，可独立单测）
│   ├── junk.ts        垃圾域：18 类安全注册表、保护/封锁清单、走查、id 校验链、trash 三级
│   ├── apps.ts        应用域（M3 桩）
│   ├── types.ts       领域契约、PcManagerError、封闭错误词表 PcErrorCode
│   ├── tools.ts       唯一接触 defineTool 的注册层：guarded() 异常→封闭错误联合
│   └── client/        浏览器半：仪表盘 / 垃圾清理窗口 / 悬浮窗 / locale（值导入仅 react 系）
├── tests/             vitest：全部解析器 + 垃圾域全套（注册表逐条 pin、校验链逐层）
├── cordis.patch.yml   宿主挂载清单（purely additive，不覆盖内置插件）
├── tsdown.config.ts   client bundle 自包含构建（CJS + window.__ModuleLoader__ 工件契约）
├── tsconfig.json      类型检查专用（paths 把依赖映射到 harness 包节点）
└── package.json
```

## 本地开发

前置：本仓库与 deepseek-harness **并列检出**（本仓库在 `../dsh-pc-manager`、harness 在
`../deepseek-harness`，路径不同请自行替换）。依赖与工具链（tsdown / vitest / tsc）全部借
harness 侧解析，本仓库**不要 `pnpm install`**。

一次性装载通道（外部 client 插件经 profile 的 node_modules 符号链接解析，loader 的
linkedRoots 与 client-modules 扫描都以此为准），在**本仓库根**执行：

```bash
mkdir -p ~/.dsh/profiles/web/node_modules/@deepseek-ai
ln -sfn "$PWD" ~/.dsh/profiles/web/node_modules/@deepseek-ai/dsh-pc-manager
```

构建仪表盘 client bundle（借 harness 的 tsdown，产出 `lib/client.js`）：

```bash
cd ../deepseek-harness
node_modules/.bin/tsdown --config ../dsh-pc-manager/tsdown.config.ts
```

运行（在 harness 仓库根执行）：

```bash
pnpm dsh --patch ../dsh-pc-manager/cordis.patch.yml --profile web
```

host 半（工具 + 路由）由 loader 直接吃 TS 源码；只有 client bundle 需要先构建。

### 测试与类型检查

harness 的 vitest 配置只收 `packages/` 内的 spec，外部项目用它的 vitest 二进制以本仓库为 root 运行：

```bash
cd ../deepseek-harness
node_modules/.bin/vitest run --root ../dsh-pc-manager
node_modules/.bin/tsc --noEmit -p ../dsh-pc-manager/tsconfig.json   # 类型检查(tsdown 不查类型)
```

覆盖全部纯解析器（df/ps/vm_stat/swapusage/pmset/ioreg 电池与 GPU/iostat/netstat/nettop CSV+JSON/
进程合并排序/CPU 差分）与垃圾域全套（注册表与保护清单逐条 pin、glob 展开、走查统计、scan 语义、
校验链逐层含符号链接重定向、整体拒绝、trash 三级、量不准不删、审批摘要 en/zh 快照）。

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
- **M3（规划中）**：应用清单与卸载 —— `/Applications` bundle 走查（du + kMDItemLastUseDate）、
  `brew list` 合并、移废纸篓卸载、残留项（plist/`App Support`/缓存）报告。
- **未排期**：温度（需 sudo）、进程级 GPU/磁盘真实取数（需特权 helper）、Windows/Linux、
  pnpm store 引用计数感知清理、用户持久排除清单。

## License

[MIT](LICENSE)
