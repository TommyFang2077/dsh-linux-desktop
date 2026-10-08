# 内核与 Linux 桌面独立更新

## 两条更新链

- **内核**：完整 dsh、WebUI、私有 Host 和配套运行时安装到既有 Electron 用户数据目录的 `updates/kernels/<SHA256>`。保留 Ed25519、全量清单、协议、Node 范围、数据兼容标识、隔离试启动、原子激活与启动失败回滚。
- **HOME 桌面**：完整 Electron 程序归档安装到 `~/Applications/dsh-linux-desktop/versions/<SHA256>`。确认停止任务后原子切换 `current`，明确重启新版本路径，不调用 sudo、pkexec 或系统包管理器；保留兼容的已激活新内核。

- **deb/rpm 桌面**：完整系统软件包安装到 `/opt/dsh-workbench`；选择签名清单中与当前系统安装匹配的 deb/rpm。停止任务后使用 pkexec 的系统授权弹窗；root 所有且不可写的安装器将下载包复制到 root 临时目录，重新校验摘要、大小、身份、架构与构建号，再执行 apt/dnf。成功后重启明确的系统 executable；失败恢复后端，不删除兼容的新内核。安装器及整个父目录链必须 root 所有、无组/其他写权限且无符号链接。未安装的解包试运行拒绝提权；HOME 安装版不查询或更新系统包。

产品名、应用 ID、Electron userData 与 `~/.dsh` 均不变。应用关闭或更新失败不清理用户配置、会话、插件和内核 pending/rollback 状态。`dataEpoch` 必须一致；只有确认数据格式双向兼容才可沿用，不能为升级便利而放宽。

“官方内核”指固定官方源码的本项目 Linux 构建，不是官方托管的 Linux OTA。已核对的官方渠道没有这里所需的独立 Linux 内核签名载荷；仅安装 npm dsh 不包含完整桌面私有 Host 与支持运行时。

## 版本与 Linux 构建号

桌面 `version` 必须等于所复用官方壳源码的版本；构建时验证固定源码与元数据一致，不给 Linux 改动自增官方 alpha 编号。Linux 的重打包/适配变更只增加 `linuxRevision`。桌面更新按 `(官方版本, Linux 构建号)` 排序：同官方版本只接受更高构建号，不能用很大的构建号降级官方版本。三种产物名和发行标签同时包含这两个字段；deb 的 Version 为 `<version中的-替换为~>-<linuxRevision>`，rpm 的 Version 同样替换 `-` 为 `~`、Release 为 `<linuxRevision>`，不使用 CI run number；内核仍按其自己的版本更新。

## 首次安装与从 /opt 迁移

当前旧系统版无法自动理解新桌面归档格式。首次迁移使用用户安装入口，不改旧安装目录属主、不调用旧的提权更新器。新默认归档只有 `app/` 一棵程序树，含自己的 Node 和自包含 `resources/app/workbench/install-user.mjs`。

先独立认证下载的完整字节，再执行下载内容：签名发行用已固定的可信公钥；CI 手动安装核对仓库、成功 run 和提交，并核对 GitHub artifact API 的 ZIP digest，再核对其中 tar 的 SHA256SUMS。安装入口要求明确 `--archive`、`--sha256`、`--version`；摘要错误会在创建安装目录前失败。不能先运行未知下载的 Node 让它自己证明可信。

迁移可使用已经信任的旧安装的自带 Node验证新归档，或认证后使用新归档的 Node，无需安装宿主 Node/Python。正式切换前完全退出旧应用，保留原数据位置；用户命令与同名用户菜单入口优先启动新版本。安装器拒绝覆盖无关命令或自定义入口。旧系统包、/opt、系统启动项和仓库外签名密钥保持原状；卸载旧包另行确认。

`current` 和 `previous` 是受管理版本目录的链接；切换通过同目录临时链接加 rename 完成，不覆盖运行中的树。失败/取消或同步重启失败保留当前版本；显式 `--rollback` 可回到上一版本。保留旧树不等于自动检测 Electron 无法启动并回滚，这种守护机制暂不提供。进程中断留下安装锁时，确认没有安装进程后才能手工删除空 `.install-lock`。

## 发布源与信任

`updates.json` 固定两个清单地址和 Ed25519 公钥，清单托管在本仓库 `update-feed` 分支，资产来自版本化 GitHub Releases。来源可通过 `DSH_WORKBENCH_UPDATE_CONFIG=/绝对路径/updates.json` 在下次完全退出并启动时覆盖；更换公钥即改变信任来源，不能自动接受服务器返回的新密钥，也不能使既有用户内核失去其可信公钥。

未首次公开发行前 URL 可能为 404，本地配置完整不代表更新服务已上线。私有部署可将通道设为 `null`，窗口会禁用该通道。发布清单与资产必须使用无凭据、无 fragment 的 HTTPS；只有 GitHub Release 同仓库/同文件名到 Release 下载 CDN 的有限跳转可接受，其他重定向仍拒绝。下载和抽取有大小、数量、路径、文件类型、权限与时间限制。

内核 feed 保持 **schemaVersion 1**：签名 payload 包含完整文件清单摘要及 `asset`。桌面 feed 使用 **schemaVersion 2**：`channel: desktop`、`format: tar.gz`、单个 `asset`，保留版本、平台/架构、协议、dataEpoch、desktopRange/nodeRange、kernelRange/nodeVersion，并签名独立的 `linuxRevision` 正整数；新增 `assets: {deb, rpm}`，分别声明包 URL、大小与 SHA-256；签名同时覆盖用户归档与两个安装包。HOME 客户端继续选择 `asset`，系统客户端按已安装格式选择 `assets.deb/rpm`；缺包明确拒绝，不改用其他格式。签名覆盖完整 payload 原始字节。旧客户端应拒绝不认识的新格式，不降级签名验证或误触发系统安装。

用户拥有程序文件只解决写权限，不取消所签名载荷和实际文件的对应关系。`dsh-purge` 等工具的内核改写还涉及运行时完整性校验；此次只提供真实所选内核路径，不自动清洗、关闭审批/文件沙箱或替换外部插件配置。

## 离线签名

生产私钥在仓库外的 Unix 权限文件系统保存，权限0600，不随程序或 artifact 分发。用户安装不移动已有 `~/.local/share/dsh-workbench` 签名目录。两个通道可共用现有 Ed25519密钥，不能为修复配置问题随意换钥。

```sh
make package

node build/release-updates.mjs kernel \
  --input build/upstream/apps/desktop/.desktop-build/targets/linux-x64 \
  --output dist/kernel-release --key /secure/location/update-signing.pem \
  --base-url https://your-update-host.example/releases/version/

node build/release-updates.mjs desktop \
  --archive dist/dsh-workbench-0.2.1-alpha.1-r4-linux-x64.tar.gz \
  --deb dist/dsh-workbench-0.2.1-alpha.1-r4-linux-x64.deb \
  --rpm dist/dsh-workbench-0.2.1-alpha.1-r4-linux-x64.rpm \
  --metadata desktop.json --output dist/desktop-release \
  --key /secure/location/update-signing.pem \
  --base-url https://your-update-host.example/releases/version/
```

示例地址不是已部署来源。工具只生成本地文件，拒绝覆盖同名签名输出；桌面归档身份、运行时与所声明元数据必须匹配，两个系统包的身份、版本、架构及 Linux 构建号也必须匹配，生成后自验签名。不上传、不创建标签、不推送。

## GitHub Actions

`.github/workflows/linux-updates.yml` 复用 prepare、测试、deb/rpm 与用户归档打包和真实运行时 smoke。main 或手动构建仅上传 deb/rpm、归档、校验和及构建信息；没有签名 Secret 时明确跳过签名。签名阶段才把 Secret写入 runner私有临时文件，公私钥匹配后签名并清理，不把密钥传给构建或打进归档。

只有明确推送匹配 `desktop.json` 的 `workbench-v<官方壳版本>-r<Linux构建号>` 标签，且签名 Secret 已配置时才公开发行。顺序为成功生成/校验 → 上传不可覆盖的版本化资产 → 更新两个固定清单；仅发布作业持有 contents:write，不强推分支，不使用 `releases/latest` 选预发布版本。生产密钥上传、源码推送、发布标签与对外发布需分别明确授权。

## 验证

```sh
make test
make package
make gui-smoke
make kernel-smoke
```

测试覆盖 HOME 安装和版本回退、归档身份和权限、签名/兼容性、恶意归档拒绝、失败/取消原子性、HOME 版已有系统包时仍不提权、系统包格式与签名检查、root 安装器父目录信任检查、包版本/构建号匹配、入口碰撞、正确重启路径和内核状态保持。GUI 使用隔离 HOME/XDG、摘要验证后的用户归档、沙箱开启和真实1×1图片预览，不请求模型、不改变真实用户配置。真实用户迁移在新归档验证后单独确认。
