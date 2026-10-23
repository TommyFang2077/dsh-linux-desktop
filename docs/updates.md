# 内核与 Linux 桌面独立更新

## 官方内核跟随（2026-10-18）

具有 `followOfficial: true` 的更新器使用稳定跟随源，优先更新内核和其自带运行时，保留当前 Electron 壳。新官方版本保留独立数据纪元，不再要求预先证明旧内核能使用新版的所有新功能。用户确认后使用现有外部迁移 worker 退出、检查写入者、完整备份和验证，再激活精确内核并重启同一壳。健康失败保留锁和快照，恢复须将程序状态与数据一起恢复；旧的普通同纪元路径保持原有规则。

alpha.5-r2 须先通过原桌面通道安装 alpha.5-r3 过渡包，后续才能使用跨纪元独立内核更新。真实发布状态和验证证据见 [自动跟进](automatic-updates.md)。下文历史 epoch 专属 feed 与 alpha.1/alpha.2 路径继续为旧客户端保留。

## 独立更新与整包迁移

- **内核**：完整 dsh、WebUI、私有 Host 和配套运行时安装到既有 Electron 用户数据目录的 `updates/kernels/<SHA256>`。保留 Ed25519、全量清单、协议、Node 范围、数据兼容标识、隔离试启动、原子激活与启动失败回滚。
- **HOME 桌面**：完整 Electron 程序归档安装到 `~/Applications/dsh-linux-desktop/versions/<SHA256>`。确认停止任务后原子切换 `current`，明确重启新版本路径，不调用 sudo、pkexec 或系统包管理器；保留兼容的已激活新内核。
- **跨 epoch 整包升级**：独立的 `desktopUpgrade` 通道验证目标桌面及内置内核，不放宽普通更新的兼容检查。外部迁移进程等待旧 Electron 实际退出，验证完整数据备份后再切换与启动；具体支持范围、失败保持和整组恢复见 [过渡升级与恢复](desktop-migration.md)。

- **deb/rpm**：只将引导器、Node 验证/安装运行时和桌面归档作为 root 管理的静态载荷放在 `/usr/share/dsh-workbench`，并提供 `/usr/bin/dsh-workbench` 启动器。首次正常用户启动时，用包管理器信任的本地载荷摘要调用现有 HOME 安装器；程序与插件只从 `~/Applications/dsh-linux-desktop` 运行。root 调用明确拒绝；启动器不猜测桌面登录用户、不执行 Electron/插件，也不以提权身份访问 HOME。包管理器升级只更新引导载荷，不覆盖或降级已有 HOME 版本。

产品名、应用 ID、Electron userData 与默认 DSH 数据根均不变。应用关闭或更新失败不清理用户配置、会话、插件和内核 pending/rollback 状态。普通更新的 `dataEpoch` 必须一致；只有确认数据格式双向兼容才可沿用。整包迁移保留目标的真实新 epoch，而非把新内核声明为旧格式兼容。

“官方内核”指固定官方源码的本项目 Linux 构建，不是官方托管的 Linux OTA。已核对的官方渠道没有这里所需的独立 Linux 内核签名载荷；仅安装 npm dsh 不包含完整桌面私有 Host 与支持运行时。

## alpha.1 → alpha.2 升级边界

alpha.2 新增必需的 `working-directory/change` 会话事件，并将外部子代理目录写为 `subagent/catalog` version 2。虽然上游 Session 版本仍为 4，alpha.1 读取器会拒绝这些新记录，因此本发行使用新的 `dataEpoch: dsh-0.2.1-alpha.2`，不宣称双向数据兼容。

旧 r7 的桌面与内核 OTA 会按既有规则阻止直接跨 epoch 更新，并非清单缺失或下载故障。本轮源码增加 `alpha.1 → alpha.1 r9 过渡包 → alpha.2 r3 整包升级`：旧格式签名清单先提供同 epoch 过渡包，再由过渡包的新入口完成退出、自动备份和迁移。源码与本地验收不等于线上已经发布；生产更新源与真实安装切换均另行确认。过渡发布前，手动完整归档安装仍须先完全退出并备份实际 DSH 数据根和 Electron userData。只更新 deb/rpm 引导包不会替换已有 HOME 版本。

新版保留已提交的旧内核指针与文件，但不会选用不兼容的 alpha.1 内核。尚未提交的独立内核试启动仍遵循原有 staged → booting → healthy 生命周期，启动中断时恢复 previous 指针；这不是冻结 pending 状态，也不恢复会话数据。其 pnpm 入口改在 `runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs`。

启用 alpha.2 后若需回到 alpha.1，必须同时恢复升级前的数据备份；仅切换程序或内核指针不恢复会话数据。alpha.2 同 epoch 的后续兼容版本仍走原有独立更新通道。

## 设置中的版本检查

通用设置分别读取当前实际选用的内核、桌面壳版本与 Linux 构建号，检查两个普通通道和配置启用的整包升级通道。最新发布与可安装更新分别表示：相同或更旧的发布仍显示其签名版本，但不会变为升级候选；普通通道遇到协议或数据不兼容仍显示错误。单个通道失败不隐藏其他通道结果，可以重试检查。

归档由独立、内存受限的子进程通过原生文件系统解包，避免 Electron ASAR 虚拟路径截获；桌面产物不含无用的默认 ASAR 程序，使已发布的旧更新器也能解包。普通桌面更新先安排新程序路径，待安装器、暂存目录及安装锁完成清理后退出；整包迁移则将归档交给独立 worker，退出旧进程后才备份与切换。清单请求限制两分钟，完整载荷下载限制十分钟，仍校验签名声明的大小与摘要。

## rc.2 插件市场更新失败时

应用市场是用户 profile 中的独立插件。旧市场可能把已安装插件的更新作为首次安装提交，触发原生管理器的 `already-installed` 拒绝；随后再用同样的方法恢复旧版，又会误报恢复失败。市场增加卸载后重装逻辑后，热重载仍可能在安装途中卸载市场自身，使更新等待自身退出而无法完成。升级市场版本本身不证明这条链路已恢复。

本机修复采用官方支持的“更新后重启生效”模式，不修改已签名内核或市场代码。完全退出应用、确认后台 Host 和插件进程均已结束后，备份实际 `DSH_HOME/profiles/desktop/cordis.patch.yml`，在现有补丁列表末尾增加：

```yaml
- id: hmr
  disabled: true
```

保留原有补丁；空列表 `[]` 应替换为上面的列表，不能直接在 `[]` 后追加。完整重启后，原生管理器允许原地更新已安装插件，兼容检查、构建脚本审批、包操作锁及失败恢复继续执行。插件更新成功后，通过托盘正常重启，再使用新版本；组合包启停和 profile 补丁也须重启生效，运行中卸载可能仍要求先退出应用。

该模式已用真实隔离 Host 的市场更新及重启验证，并运行原生管理器的安装失败、取消与保留旧运行版本回归。验收应同时检查市场操作成功、当前运行版本和重启后的插件状态，不能仅根据磁盘上的包版本判断生效。需要恢复热重载时，在完全退出应用后撤销这条补丁，再重启。

## 子智能体派发失效（rc.2）

`subagent` 与 `spawn_teammate` 曾以 `cannot get property "agents" without inject` 失败，而只读的成员列表仍可用。原因是任务准入补丁在 `SubagentRuntime` 和 `LocalJobRegistry` 上新增的 `updateAdmission` getter 直接读取 `this.ctx.agents`：Cordis 把服务读取时的 `this.ctx` 重绑为**调用方**的 fiber，而 `dsh-tool-subagent` 只注入 `subagents`，不注入 `agents`，于是取属性那一刻抛出，可选链无效。两处改为 `ctx.get('agents')` 的严格读取，与静态 `inject` 无关。回归用例从只注入 `jobs` 或 `subagents` 的调用方读取该门，旧写法会以相同错误失败。

## 启动失败与累积的认证 cookie（rc.2）

应用曾以 `desktop welcome: Web authentication failed` 启动失败。真因是 Electron cookie jar 里累积了数十个 `dsh-auth-*`：Host 的 cookie 名取自启动权威（含随机端口），每次启动都铸新名，旧名直到 30 天过期才消失。请求头累积到约 16 KiB 后超过 Host 的请求头上限，得到 431，而壳把所有非成功响应都译成认证失败，日志里看不到状态码。现在启动握手前先删除同 host 的旧 `dsh-auth-*`，并把 HTTP 状态码写进该错误信息。已有安装无需手动清理：升级后的首次启动会自行清掉旧条目。

## 版本与 Linux 构建号

桌面 `version` 必须等于所复用官方壳源码的版本；构建时验证固定源码与元数据一致，不给 Linux 改动自增官方 alpha 编号。Linux 的重打包/适配变更只增加 `linuxRevision`。桌面更新按 `(官方版本, Linux 构建号)` 排序：同官方版本只接受更高构建号，不能用很大的构建号降级官方版本。三种产物名和发行标签同时包含这两个字段；deb 的 Version 为 `<version中的-替换为~>-<linuxRevision>`，rpm 的 Version 同样替换 `-` 为 `~`、Release 为 `<linuxRevision>`，不使用 CI run number；内核仍按其自己的版本更新。

## 首次安装与从 /opt 迁移

旧版 `/opt` 运行时无法自动理解新的引导包布局。通过包管理器升级时只替换旧系统程序为惰性引导载荷，不在 root 安装脚本中推断登录用户或启动用户代码；完全退出旧应用后，以普通用户从桌面入口启动，引导器才会将经包管理器认证的归档安装到 HOME。归档升级和 deb/rpm 首次安装最终都使用同一个 HOME 安装器。

先独立认证下载的完整字节，再执行下载内容：签名发行用已固定的可信公钥；CI 手动安装核对仓库、成功 run 和提交，并核对 GitHub artifact API 的 ZIP digest，再核对其中 tar 的 SHA256SUMS。安装入口要求明确 `--archive`、`--sha256`、`--version`；摘要错误会在创建安装目录前失败。不能先运行未知下载的 Node 让它自己证明可信。

归档安装直接运行归档内的 Node；deb/rpm 引导安装使用 root 管理载荷中的 Node 与同一安装器，全程以启动该引导器的普通用户运行，不依赖宿主 Node/Python。正式切换前完全退出旧应用，保留原数据位置；HOME 用户命令与菜单入口由现有安装器创建。安装器拒绝覆盖无关命令或自定义入口。更新引导包不迁移或重置配置、会话或签名密钥。

`current` 和 `previous` 是受管理版本目录的链接；切换通过同目录临时链接加 rename 完成，不覆盖运行中的树。失败/取消或同步重启失败保留当前版本；显式 `--rollback` 可回到上一版本。保留旧树不等于自动检测 Electron 无法启动并回滚，这种守护机制暂不提供。进程中断留下安装锁时，确认没有安装进程后才能手工删除空 `.install-lock`。

## 发布源与信任

`updates.json` 固定普通内核、普通桌面与独立整包升级的清单地址和 Ed25519 公钥，清单托管在本仓库 `update-feed` 分支，资产来自版本化 GitHub Releases。旧根清单服务 alpha.1 过渡包，alpha.2 使用 epoch 专属文件；已发布 alpha.2 r1 的显式配置切换见 [双更新源](desktop-migration.md#双更新源)。来源可通过 `DSH_WORKBENCH_UPDATE_CONFIG=/绝对路径/updates.json` 在下次完全退出并启动时覆盖；更换公钥即改变信任来源，既有客户端不自动接受服务器返回的新密钥。

未首次公开发行前 URL 可能为 404，本地配置完整不代表更新服务已上线。私有部署可将通道设为 `null`，窗口会禁用该通道。发布清单与资产必须使用无凭据、无 fragment 的 HTTPS；只有 GitHub Release 同仓库/同文件名到 Release 下载 CDN 的有限跳转可接受，其他重定向仍拒绝。下载和抽取有大小、数量、路径、文件类型、权限与时间限制。

内核 feed 保持 **schemaVersion 1**：签名 payload 包含完整文件清单摘要及 `asset`。桌面 feed 使用 **schemaVersion 2**：`channel: desktop`、`format: tar.gz`、单个 `asset`，保留版本、平台/架构、协议、dataEpoch、desktopRange/nodeRange、kernelRange/nodeVersion，并签名独立的 `linuxRevision` 正整数；`assets: {deb, rpm}` 是给包管理器用户手动下载/升级引导包的签名附件。所有正在运行的应用客户端统一选择 `asset`，按现有用户安装器写入 HOME；更新不自动执行包管理器或授权弹窗。签名覆盖完整 payload 原始字节。旧客户端应拒绝不认识的新格式，不降级签名验证或误触发系统安装。

用户拥有程序文件只解决写权限，不取消所签名载荷和实际文件的对应关系。`dsh-purge` 等工具的内核改写还涉及运行时完整性校验；此次只提供真实所选内核路径，不自动清洗、关闭审批/文件沙箱或替换外部插件配置。

## 离线签名

生产私钥在仓库外的 Unix 权限文件系统保存，权限0600，不随程序或 artifact 分发。用户安装不移动已有 `~/.local/share/dsh-workbench` 签名目录。手动下载的 deb/rpm 应先按签名清单验证来源和摘要；`apt install ./文件.deb` 或 `dnf install ./文件.rpm` 本身不替代这一步。安装后，引导器使用软件包内固定的 SHA-256 验证桌面归档；桌面和内核 OTA 仍验证 Ed25519 签名清单，不能为修复配置问题随意换钥。

```sh
make package

node build/release-updates.mjs kernel \
  --archive dist/dsh-workbench-0.2.1-alpha.2-r3-linux-x64.tar.gz \
  --output dist/kernel-release --key /secure/location/update-signing.pem \
  --base-url https://your-update-host.example/releases/version/

node build/release-updates.mjs desktop \
  --archive dist/dsh-workbench-0.2.1-alpha.2-r3-linux-x64.tar.gz \
  --deb dist/dsh-workbench-0.2.1-alpha.2-r3-linux-x64.deb \
  --rpm dist/dsh-workbench-0.2.1-alpha.2-r3-linux-x64.rpm \
  --metadata desktop.json --output dist/desktop-release \
  --key /secure/location/update-signing.pem \
  --base-url https://your-update-host.example/releases/version/
```

示例地址不是已部署来源。工具只生成本地文件，拒绝覆盖同名签名输出；桌面归档身份、运行时与所声明元数据必须匹配，两个系统包的身份、版本、架构及 Linux 构建号也必须匹配，生成后自验签名。不上传、不创建标签、不推送。

## GitHub Actions

`.github/workflows/linux-updates.yml` 是只读权限、无生产签名 Secret 的可复用构建测试流程，覆盖 PR、main 和手动构建。它准备、测试并打包 deb/rpm 与用户归档，使用一次性临时密钥生成待签清单，再上传构建产物；一次性签名不受客户端信任，不能当作正式更新发布。

发布入口有两个：显式推送匹配 `desktop.json` 的 `workbench-v<官方壳版本>-r<Linux构建号>` 标签（`linux-release.yml`），或 `upstream-release.yml` 每 6 小时发现官方 Release 后，依据可信主线开启的跟随策略，通过构建和已发布旧壳的真实内核迁移测试，再复核并合并升级 PR。启用跟随后无需逐个填写同纪元兼容记录；适配失败停止发布，旧客户端仍保留历史兼容门禁。不追踪普通分支提交，不使用 `releases/latest` 选择预发布版本。

两条入口均直接调用 `publish-updates.yml`，避免 `GITHUB_TOKEN` 创建 PR/标签不触发下一工作流的问题。生产签名密钥仅进入独立新 runner 的签名步骤；该步骤执行受信仓库脚本，重新验证官方 Release，核对元数据、资产摘要与内核适配报告，不执行下载的构建代码。顺序为验证与签名 → 草稿上传全部不可覆盖的版本化资产 → 公开发行 → 推进跟随清单。只有精确的 alpha.5-r3 过渡包同时推进旧 alpha.4 epoch 清单；后续内核不覆盖旧客户端的清单。发布并发组串行提交并拒绝 feed 版本/构建号倒退。发现/合并作业只按职责获得 contents、pull-requests 或 statuses 写权限；不强推、不绕过分支保护。

需要配置既有公钥对应的 `DSH_WORKBENCH_UPDATE_SIGNING_KEY` 以及仓库权限。启用条件、兼容记录和失败恢复见 [自动更新策略与维护](automatic-updates.md)。本次交付包含通过验证后的 GitHub 发布；真实用户安装仍由客户端确认。

## 验证

```sh
make test
make package
make gui-smoke
make kernel-smoke
```

测试覆盖 HOME 安装和版本回退、归档身份和权限、签名/兼容性、恶意归档拒绝、失败/取消原子性、统一用户级更新、包版本/构建号匹配、软件包禁止 `/opt` 路径、入口碰撞、正确重启路径和内核状态保持。GUI 使用隔离 HOME/XDG、摘要验证后的用户归档、沙箱开启和真实1×1图片预览，不请求模型、不改变真实用户配置。真实用户迁移在新归档验证后单独确认。
