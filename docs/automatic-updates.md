# 自动跟进与确认安装

rc.2 的普通 OTA 审核已因反向 Web provider 设置不兼容停止，具体证据、测试修复与整包迁移方案见 [alpha.5 → rc.2 兼容性审核](rc2-compatibility.md)。

## 已确认策略

- 跟进 `deepseek-ai/deepseek-harness` 官方 Release，包括正式版与 alpha/beta 等预发布版；不追踪普通分支提交。
- 项目侧每 6 小时检查新版本，创建升级 PR 并执行构建、测试。只有明确兼容且验证通过的升级才可自动合并、签名发布；不兼容或无法证明兼容时转人工，不用版本号范围代替兼容证据。
- 客户端启动时及运行期间每 6 小时检查，失败后退避重试。后台下载并校验后提示用户，用户确认后才安装；活动任务未结束或状态无法确定时不得自动中断任务。安装需要重启时明确提示。
- 跨数据格式升级不进入自动发布链，不静默迁移用户数据。
- 官方源码内核、项目 CI 构建签名分发；不是官方托管的 Linux 更新源。

## alpha.4 本地交付与验收完成（未部署发布）

用户已确认升级适配官方 `dsh-v0.2.1-alpha.4`，保留现有自动更新与任务准入保护。未来补丁冲突允许受限 AI 自动尝试生成修补候选 PR 和测试结果；凡含 AI 代码修改的升级必须人工批准合入，不能沿用无代码修补升级的自动合并资格。失败、超限或兼容性未知时停止并保留证据，不承诺任意上游版本均可无人值守适配。

当前alpha.4源码、受限AI候选流程、分阶段构建及三格式包已完成本地验收：官方9/9构建gate、独立严格编译、Python41/41、冻结全Node170/170及后续烟测契约14/14、真实GUI与内核更新烟测通过。此前alpha.2和中途失败记录保留为历史，不能当作当前证据；下文按阶段标明。AI服务默认关闭，线上Actions/真实模型和生产签名发布未启用或验证。未推送、发布或替换当前安装，未修改原冲突build/upstream。

构建隔离预检：Lead 独立运行极小 user-systemd/cgroup v2 实验，父子进程使用不同 SID/PGID 但属于同一 cgroup；内核控制值为 MemoryMax=64 MiB、MemorySwapMax=0、TasksMax=8。RuntimeMaxSec=4s 与 KillMode=control-group 在 4.074 秒终止父子进程，身份核查均已消失，cgroup 删除，自建 unit 已清理。原始复测日志：`/tmp/dsh-lead-isolation-probe.log`，外层退出 0，内部预期 timeout 退出 1；cgroup MemoryPeak=6,717,440 bytes。这验证普通 setsid 子进程的资源归属与超时清理，不是恶意代码沙箱，不证明主动创建其他 service 或迁移 cgroup 被阻止，也不代表 alpha.4 完整构建通过。

### alpha.4 严格验证与修复历史（最终通过）

首次新依赖隔离验证自然退出 1（6分17秒，未触发600秒超时）：36通过、2失败。真实 Typert 生成器拒绝 `packages/core/agent/src/index.ts:247:3` 的公共属性缺少显式类型，错误为 `public property is missing an explicit type annotation`；另一失败为隔离 wrapper 缺 `build/whole-desktop.mjs`，不代表完整安装包缺件。日志 `/tmp/client-alpha4-fresh-strict.log`。

修复候选补丁 SHA256 为 `e11ec5ef9cd239337c575d2cba79b1ee115d68414306928fb2af33dcfca5dfbc`。Lead 对照首候选确认仅新增 `readonly version: 1 = 1` 和 `readonly updateAdmission: UpdateAdmissionGate = new UpdateAdmissionGate()` 两处类型声明，运行控制逻辑不变。缺失 bundle 在新验证目录从当前源码和新依赖重新生成，未借旧产物。该两行修复的真实 Analyzer 红绿已通过，但随后全目标仍为42通过、1失败：SubagentRuntime 公共 getter 也缺显式返回类型（`/tmp/client-alpha4-fresh-strict-fixed.log`，自然退出1，5分37.701秒）。随后完整检查新增公共接口，为 ReactLoopAgent、LocalJobRegistry、SubagentRuntime 的三个 getter 补上 `Context['agents']['updateAdmission']` 返回类型，返回表达式不变。最新补丁 SHA256 为 `966f3fffac72c488f369f5609100800df0edf6b059a7a3d1dccb5bdf1be2cb02`。六相关包真实 Analyzer 红绿通过、默认诊断开启（`/tmp/client-alpha4-narrow-getters.log`，57.505秒）；Lead 已读取日志，独立增量静态审查未发现运行语义或 RPC 暴露变化。最终执行者及 Lead 独立复跑均通过真实完整生成器、原八项目严格编译和六文件客户端回归：56/56、0失败、0跳过。Lead 日志 `/tmp/dsh-lead-alpha4-strict.log`，退出0、5分52.285秒；运行中 cgroup 限额/内存及进程清单在 `/tmp/dsh-lead-alpha4-strict-cgroup.log`。精确输入哈希 `/tmp/client-alpha4-final-inputs.sha256`；六关键模块解析与37个补丁目标对应证据 `/tmp/client-alpha4-source-proof.log`。task11仅通过本地源码验收，不代表安装包或线上发布通过。现已授权一次全新隔离完整构建，cgroup24GiB、swap0、Node old-space16GiB、最长2小时，失败留证停止不自动加堆；该次完整构建已结束失败：`/tmp/dsh-alpha4-full-hcV4ltTd/logs/full.raw.log` 记录官方9 gates为8通过、1失败、0跳过；Host/Client/Desktop bundle、Web等通过，唯一 Host aggregate 在 `apps/desktop/scripts/retain-desktop-ci.ts:52` TS2322、`:65` TS2345，Linux 扩展 target 不符合官方 mac/win 更新保留目标类型。总12分44.080秒，退出1，cgroup MemoryPeak=10,607,104,000 bytes、swap0，非OOM；unit进程已清理。未进入build-updates/package，因此没有三类安装包或GUI烟测结果。该类型问题随后以单行 Linux 提前拒绝 guard 修复，其他平台正文不变。最终补丁 SHA256 为 `f8e283e2ab1ffd47e2d18e52e19e9938aaad47940648a792586106cb19698fd1`（38个目标）；真实 Host aggregate 同一 `--max-old-space-size=4096 tsc -p tsconfig.host.json` 红绿通过，日志 `/tmp/client-retain-host-red-green.log`，绿色诊断为空。Lead 对最终测试独立5/5通过 `/tmp/dsh-lead-alpha4-retain-final.log`，增量静态审查确认 Linux 不进入官方 retain IO、完整Linux打包不调用该入口。已在原隔离构建目录进行一次修复后的增量完整重跑，非全新干净构建；日志 `logs/retry1/full.raw.log`，仍24GiB/swap0/2小时/Node16GiB，不跳gate。该重跑官方9/9 gates通过（95.00秒），release:pack及native打包完成，但在首个prepare:runtime以 `TypeError: fetch failed` 退出1；9分25.871秒，MemoryPeak=6,726,713,344 bytes、swap0，非OOM，无遗留unit进程。尚无最终tar/deb/rpm或GUI结果；原下载错误未复现；同隔离Node默认TLS下官方Electron小Range GET206及校验清单GET200，但不据此还原历史errno。一次分阶段恢复随后通过prepare:runtime、prepare:packages、prepare:dsh、electron-builder Linux目录打包及封装runtime/Host烟测（含CLI离线插件、sharp及Office转PDF），但tar归档在 `scripts/build.py:110` 安全检查失败：`RuntimeError: Desktop archive cannot contain links or special files`。因此仍无最终三包，正在窄诊断具体违规条目，不放宽归档安全策略。恢复日志 `/tmp/dsh-alpha4-full-hcV4ltTd/logs/recovery1/full.raw.log`（含临时烟测token，不原样公开），退出1、6分13.386秒、MemoryPeak=2,229,641,216 bytes、swap0，进程已清理。

### alpha.4 首候选与待验收项

- 候选官方提交：`86a402200d95fecef4529d969836f1fe13c6cb0d`；Lead 已在隔离源码核实 HEAD、版本 `0.2.1-alpha.4` 与 pnpm `11.28.5`。当前桌面候选为 r1、Electron `44.7.0`、独立 `dsh-0.2.1-alpha.4` 数据纪元；不据此宣称旧数据双向兼容。
- 首候选补丁 SHA256：`74ab448e13013687309459cdd38bedf3e7b5dfd7fbf0df0fba867a3102791a03`。迁移者报告保留全部 37 个原目标，32 个直接应用、5 个手工融合；清单在 `/tmp/client-alpha4-port-audit.md`。新依赖下的完整验证尚待执行。
- 限定 Spec 复审未发现 jobs-local、subagent、Host 更新锁及 desktop 失败解锁的明确行为回退；Lead 另读 Host 锁和 disposal unknown 标记代码。该结论不覆盖全部桌面迁移，也不代替最终哈希复审与行为测试。
- alpha.4 新依赖已准备完成：`/tmp/dsh-alpha4-deps-JLyO8EVf/source` 单次 `pnpm install --frozen-lockfile` 退出 0，Node 24.21.0 / pnpm 11.28.5 / TypeScript 6.0.3；锁文件前后 SHA256 均为 `ee1c37b5429c535974bafa09475cb03fc473e87dded8f56d54d909ed621e1317`。Lead 已读取安装结果和软链审计：8,923 个软链无外部指向、无断链；所属 unit 结束、cgroup 移除。原始日志报告 8分42.707秒、内存峰值 5.0G、swap 0B。证据为该临时目录父级的 `install.raw.log`、`install-result.json` 和 `dependency-audit.json`。
- 最终编译与行为测试必须使用上述新依赖和隔离 wrapper 工作区，避免配置静态导入原有 `build/upstream`。旧依赖下测试仅为诊断；完整构建、安装包和升级烟测仍未验收。

## 实施边界

本次仅实现、测试与审查，不推送源码、不创建发布标签、不触发真实发布，不替换当前已安装应用。自动化启用所需仓库权限与配置在交付时另列。

保持既有 Ed25519 信任根、协议/dataEpoch/Node 兼容检查、归档与文件清单校验、安装原子性及现有恢复机制。自动下载不得切换运行内核或桌面指针。确认安装时须重新核实目标、缓存完整性和安装条件。

## 任务与验收

| 任务 | 责任边界 | 验收重点 |
| --- | --- | --- |
| 上游跟进与发布 | 工作流、发现/验证脚本、对应测试 | Release 排序与去重；未知兼容性转人工；测试 SHA 与合并/发布 SHA 绑定；PR 构建不能接触签名密钥；可靠触发后续工作流 |
| 客户端更新 | 更新模块、Linux 补丁、UI、对应测试 | 调度与退避；下载并发去重；损坏缓存拒绝；用户确认；活动任务/未知状态阻断；真实生命周期接线 |
| 集成验收 | Lead 复审、回归与文档 | 单元测试不代替打包/GUI或线上验证；分别记录已验证项与未验证限制 |

## Linux Python 别名部署适配

官方 Python 载荷中的 `bin/python`、`bin/python3` 指向 `python3.12`，与本项目无链接归档策略冲突。wrapper afterPack 仅在最终部署副本中验证并物化这两个别名为独立普通文件；原 prepared runtime、runtime.json、payloadDigest 和官方 format7 不变。其余链接及特殊文件仍拒绝，目标通过 O_NOFOLLOW/O_NONBLOCK 和文件描述符检查。归档 guard 未放宽。

准备阶段的官方 smokePrimaryRuntime 要求符号链接，不能对物化副本宣称兼容；实际打包烟测使用另一条已经核实的调用链。最终 wrapper SHA256 `e649b2ef7d5dcc247eba18829f1c6ed2571397d07a379215429bc7a2c40528ce`，Lead 独立16/16测试通过 `/tmp/dsh-lead-python-aliases-tests.log`，含真实FIFO有界拒绝；独立静态复审关闭FIFO阻塞问题。真实部署28673条目仅两个别名变化，三个Python命令隔离模式numpy/pandas通过；真实packaged runtime/Host烟测通过 `/tmp/client-python-built-smoke.log`（54.679秒），不能等同GUI验收。一次缺编译库的验证fixture ESM加载失败已保留，随后复制真实完整built source后通过。最终仅bundle分阶段恢复成功（`/tmp/dsh-alpha4-full-hcV4ltTd/logs/bundle1/`，1分47.715秒），tar.gz/deb/rpm均生成且Lead独立SHA256SUMS三项通过，额外verify通过。产物在 `/tmp/dsh-alpha4-full-hcV4ltTd/workbench/dist/`，build-info标明official:false、alpha4-r1及官方commit86a402200d95fecef4529d969836f1fe13c6cb0d。GUI实际烟测修订旧界面断言后通过（`logs/gui-smoke2/`），覆盖启动/设置/更新渠道拒绝及全窗口sandbox，不覆盖真实tray视觉。全Node串行最终冻结输入170/170、0skip通过 `/tmp/client-alpha4-full-node-final2.log`；后续仅kernel烟测旧二次确认移除及contract测试改动未包含在该170计数，Lead对应独立14/14通过 `/tmp/dsh-lead-single-consent.log`，真实kernel最终重跑通过 `/tmp/dsh-alpha4-full-hcV4ltTd/logs/kernel-smoke3/`（1分53.961秒、exit0）：临时签名HTTPS下载、真实Host probe、确认前不安装及busy拒绝、一次明确同意后正常退出、staged、手动重开选择测试内核alpha4→alpha5且桌面仍alpha4、pending清空。这里alpha5是同epoch测试夹具版本，不是官方alpha5分发或跨epoch迁移证明；全部密钥和数据临时，未改当前安装。测试close等待仍受较短局部超时限制，不声称所有慢主机均可通过。此前完整回归137/128pass8fail1skip、142/141pass1fail、157/156pass1fail的隔离fixture缺项及修复均保留，不能拼接视为单次全绿。

## AI 冲突修补（本地候选，尚未线上启用）

`scripts/upstream-repair-service.json` 默认 `enabled: false`，endpoint/model 为空。启用时维护者须在可信默认分支明确配置 HTTPS 模型地址和模型，并配置独立 `UPSTREAM_REPAIR_API_KEY`；本次没有调用真实模型或配置凭据。仅允许 `upstream-repair-policy.json` 中的两个桌面构建脚本进行有限语义修补；其他补丁片段必须逐字节不变，超出范围转人工，不保证所有新版冲突均可自动修好。

修补、无密钥验证、可信提交及候选测试分离。候选来源绑定可信 run、精确 head、artifact ID 与摘要，并由可信提交阶段写入状态，拒绝同名产物替换。AI 路径不调用 merge、tag 或 publish；人工工作流核实精确 SHA 的有效人类审查和测试后只写审查状态，实际合入由维护者在 GitHub 完成。状态是检查时的快照，不是持续有效的合并授权，合入前须重新检查 base、head 和 reviews。仓库写权限持有者仍属于信任边界。

不默认强制会同时阻断普通自动升级 PR 的全局人工门禁。维护者可选择原生 strict/up-to-date、撤销过期审批等保护，但应评估其对全分支 PR 的影响。未知兼容性不能因 AI 修补或人工审查状态而取得自动发布资格。

Lead 独立复跑全部 Python 测试 41/41 通过（`/tmp/dsh-lead-alpha4-python-all.log`）；其中 `example.txt` 补丁拒绝是负例，日志中的 609-byte archive 是测试夹具，不是实际安装包。另有模拟 HTTPError 的 ResourceWarning，未导致失败。release/publisher Python 25/25、Node workflow 7/7 定向复跑也均通过；日志 `/tmp/dsh-lead-alpha4-release-tests.log`、`/tmp/dsh-lead-alpha4-workflow-tests.log`。控制器候选 SHA256 为 `6ca55d32cde96e56b3ea663b1c560c6bb5e70013921e49726e628c8ce641e85d`；最终独立增量静态审查已完成，10 个候选文件哈希匹配，未发现确定问题；该子任务通过本地验收。离线模拟不证明真实服务、线上 Actions 权限或生产签名可用。

## 仓库侧启用

1. 将审查后的实现合入默认分支，启用 GitHub Actions，并允许 Actions 创建 Pull Request。定时入口只在默认分支工作，计划为 `17 */6 * * *`（UTC；GitHub 调度可能延迟）。也可手动运行该入口。
2. 保持 `updates.json` 的既有信任根，将对应私钥配置为 `DSH_WORKBENCH_UPDATE_SIGNING_KEY`；不要在 PR、日志或文档中粘贴私钥，不为启用自动化重新生成公钥。生产密钥只注入发布 runner 的签名步骤。
3. 仓库允许 merge commit，不能只允许 squash/rebase。按工作流声明开放 contents / pull-requests / statuses 权限；可将 `upstream-release/tested-head` 配为所需检查。其他必需检查、审批或分支保护未满足时仍会阻断，不要为了通过而关闭保护。
4. 人工审查兼容证据后，在默认分支的 `scripts/upstream-policy.json` 中添加精确 transition。`transitions` 初始为空，因此默认只发现、建 PR 和测试，不会把未知新版本自动发布。
5. 首次启用应实际验证一次无兼容授权的候选不会合并，再验证受审查候选的 CI/发布链。当前本地测试不证明线上权限、规则、密钥和 feed 服务可用。

### 兼容记录

`policy.sources` 保留已审核官方版本对应的 `{commit, pnpm}`；自动升级授权使用 `policy.transitions`，不能只向 sources 加一条版本就当作数据兼容证据。每条 transition 需要以下字段：

| 字段 | 要求 |
| --- | --- |
| `from` / `to` | 旧/新官方源码的完整 40 位 SHA |
| `status` | 明确为 `compatible` |
| `evidence` | 数据格式双向兼容、Host 协议与运行时审查/测试的报告链接或详细依据；非空文本不是自动证明，维护者必须审查 |
| `upstream` | 完整目标 upstream.json：官方仓库、SHA、版本、精确 pnpm 版本 |
| `fromDesktop` | 与当前 desktop.json 完整相等 |
| `desktop` | 完整目标 desktop.json；version 等于目标官方版本，linuxRevision 为旧值加一，protocol/dataEpoch 不变，其余范围和 Node/Electron 元数据经过审查 |

授权记录必须先在可信默认分支存在；候选 PR 只能包含自动生成的 upstream.json、desktop.json、updates.json 三个文件。门禁重新计算整棵 Git tree，绑定测试 head SHA 与唯一 base 父提交，merge API 带精确 head SHA，合并结果必须保持相同 tree 且父提交为 base/head，否则不创建发行标签。构建、门禁和签名在同一工作流 DAG 显式连接，不依赖机器人提交触发后续事件。

同一个官方 SHA 的关闭 PR 不会自动重开；候选被改动或默认分支前移时不会强推重写旧分支。若最初是未知兼容性的 draft PR，后续补充策略也不会自动重置它：维护者需在最新 base 上人工整理并审查该 PR，按正常受审查发布流程处理。

### 发布失败恢复

- 构建、兼容门禁或分支保护失败：查看失败证据，修复后重新验证；不要手工伪造通过状态。合并后发现 tree/parents 不匹配时禁止继续发布。
- 已创建标签后签名/上传失败：修复原因后重跑原 run 的失败发布作业，复用同次验证的 artifact；不要重打/移动标签。artifact 过期须重新构建并审查，不得用未经验证文件替换。
- Release 先建立草稿；恢复上传时已存在资产必须具有相同 SHA-256、大小和 uploaded 状态，不覆盖任何已发布字节。服务不提供可验证 digest、内容冲突或公开 Release 缺文件时转人工。
- 所有资产确认上传后才公开，再提交 update-feed；feed 写入失败可重跑相同发布作业，版本或 Linux revision 倒退会被拒绝。不会强推 feed 分支。

## 客户端行为与边界

- 在 Host 与初始窗口启动成功、更新健康标记完成后启动检查；正常间隔 6 小时，失败从 5 分钟指数退避，上限 6 小时。进程退出停止调度并取消下载。同一进程同通道同摘要只通知一次，进程重启后可再次通知。
- 只自动检查、下载普通 kernel/desktop 通道。desktopUpgrade 数据迁移仍走手动检查、确认、备份流程；自动检查不会触发迁移。禁用的普通通道跳过。
- 已验证载荷缓存于 Electron userData 的 `updates/downloads/`，目录权限要求私有，使用通道和 SHA-256 命名；签名、大小、摘要与兼容性都要通过。自动下载不解包激活，不修改当前版本指针。
- 同通道下载新缓存后清理旧摘要缓存；安装前重新认证 feed、确认候选没有变化并重新校验缓存。离线或候选变化时暂缓，而不是安装未经再次核实的旧候选。
- 通知为系统非模态通知，点击打开更新窗口；系统不支持通知时仍可在软件更新中看到已下载状态。选择取消不会安装。
- 确认前后检查 Host 活动状态；正式退出前先阻止新 HTTP 请求并排空已准入请求，再在同一同步段冻结共享任务准入门禁并检查空闲。Linux 构建补丁覆盖代理工厂/异步启动、直接 AgentLoop 工厂、send/wake、inbox 插入、maintenance、后台作业投产前、内部定时任务整个 resolve/flush/commit，以及子代理启动和外部结果/资源清理生命周期；不再仅依赖 HTTP 请求锁。已有任务不被强停：忙时释放门禁、暂缓安装；未发布异步任务也计入忙。令牌隔离旧解锁请求，异步上下文许可在操作结束后失效。
- 无 Host、超时、旧 Host 缺少准入能力、第三方任务实现未共享门禁或非明确空闲状态均阻断安装。资源释放失败使本 Host 标记为未知并持续阻断更新，直至 Host 重启；不会永久冻结正常任务。成功释放后可正常安装。此门禁不是机器上所有独立 CLI 进程的全局证明，整包迁移仍需按提示关闭其他 dsh 程序。源码与行为测试已覆盖上述边界，但完整安装包与真实 GUI 升级仍未验收。
- 保留已有内核试启动回退和整包迁移恢复逻辑；未新增桌面启动失败自动 watchdog，不能据此声称任意新版本都能自动回滚。

## 本地验收（准入扩展候选）

- Lead 独立 Python unittest 全量：27/27 通过。
- Lead 独立 `node --test --test-concurrency=1 tests/*.test.mjs` 首轮：130 项、129 通过、1 失败、0 跳过；新增准入父子测试共 14 项通过。失败为 `tests/whole-desktop-migration.test.mjs:631` 的 Host writer 检查，`completed:165` 报 `Error: migration did not produce a terminal report`。原日志：`/tmp/dsh-lead-admission-full.log`。
- 在不改源码、不放宽 deadline 的前提下，独立诊断者追加一次完整串行复测：**130/130 通过、0 失败、0 跳过**，150.44 秒；Lead 已核对退出码、完整日志汇总及目标测试。证据目录：`/tmp/dsh-serial-diagnostic-j34ddiet/`，含命令、日志、阶段/worker身份/CPU采样和独立保存的报告。目标测试本次检出未知数据根的 DSH 进程并安全拒绝迁移；未复现原超时，不声称根因已修复或已证明是并发编译干扰。
- 迁移诊断界限：测试只等终态 15 秒，生产 worker 父进程等待可达 30 秒、健康确认可达 60 秒，且 backup 有四次真实 `/proc` 扫描；曾实测 backup 持续约 8 秒且 worker 存活、CPU增长。定向四轮为 3 通过/1 环境性跳过。这些支持继续调查宿主时延，但未捕获原红态，环境敏感未定因风险保留。
- 客户端执行者定向六文件自检 51/51、0 跳过，与全量重叠，不累加。准入测试从固定官方 SHA 提取源码并应用完整补丁，真实运行 Cordis 共享门禁、定时任务 resolve/flush/commit、外部资源 result/dispose 四组合；测试不再读取旧 Host 构建树。
- 类型检查已定位并修正测试前置步骤：旧 fixture 未执行官方 Host 构建中的 Typert 契约生成，导致隔离候选的 `lib/typert.remote-client.d.ts` 不存在，产生两条 `ClientRemote.productAnalytics` TS2339。调用固定 SHA 的真实 `WorkspaceTypertGenerator` 后，原稳定失败的单包编译通过；测试现先编译 Host、生成真实契约并断言 TypeScript 解析到候选目录，再执行原八项目 reference build。Lead 使用 Node 24.21.0 独立执行 `DSH_ADMISSION_TYPECHECK=1 node --test --test-reporter=tap tests/client-admission.test.mjs`：**八项目编译通过，14/14 测试节点通过、0 跳过**（13 个子场景及父测试，88.46 秒），日志 `/tmp/dsh-lead-typecheck-fixed.log`。未新增或放宽编译豁免；保留上游原有 `strict: true` 与 `skipLibCheck: true`，不声称检查了全部依赖声明。此结果不等于完整官方构建通过。
- Standards 与 Spec 两条独立源码复审均无剩余整改项。审查期间发现并修复了旧 Host 测试来源错误，以及外部资源清理失败误判空闲的问题。`git diff --check` 通过。四个工作流 YAML 已语法解析；未运行 actionlint 或线上 Actions。
- 历史基线保留：准入扩展前串行 Node 118/118；更早并行 116/118，曾出现迁移子进程超时/未产终结报告；隔离复测曾内部 40/40、外层 1 通过/1 环境性跳过。这些不能覆盖当前结果，也不能证明间歇失败根因已修复。
- 当前结论：**源码实现、准入行为覆盖与本地回归/双轴审查已完成；发布前验证继续中，不宣称发布就绪。** 最新全量复测通过，但原间歇性迁移失败保留；八项目类型检查问题已解决，完整安装包、真实 GUI 和线上 CI/签名发布尚未验证。干净构建在独立目录使用 Node 24.21.0 / pnpm 11.28.5、全新依赖，8,812 个依赖软链接均未指向隔离目录外。两次完整官方构建均在 Host tsdown 阶段耗尽 JavaScript 堆（子进程退出 134，构建命令退出 1）：默认预算约 4 GiB，12 GiB 重试仍失败；此前原生模块与 Host tsc 已通过，但尚未进入完整 client 构建。失败日志保留在 `/tmp/dsh-clean-build-uh_cng_p/build-initial.log` 和 `build-heap12.log`。最后一次 24 GiB 尝试在 379.05 秒主动安全中止：官方构建创建独立 session/process group，原监控仅覆盖根进程组，无法保证全树的资源/超时边界。执行者按父链与 pidfd 身份终止了本次构建的 14 个进程；Lead 随后核对 PID/startTime，未发现仍存活的匹配进程。该次不是 OOM，不能认定 24 GiB 不足，根组采样也不代表全树内存峰值。证据：`/tmp/dsh-clean-build-uh_cng_p/build-heap24-safety-stop.json`。不再自动重试；继续打包前须建立跨独立进程组的可靠资源隔离，并定位完整构建的内存问题。不能将局部类型检查通过替代完整构建。完成打包与实际升级烟测后，再按上文启用仓库自动化。

未运行真实 GitHub 写入、签名发布、当前安装切换或 GUI 升级。当前 `build/upstream` 存在预先遗留的冲突，保留不动；补丁验证使用固定官方 SHA 的隔离副本，不以旧构建树的状态代替干净打包结果。
