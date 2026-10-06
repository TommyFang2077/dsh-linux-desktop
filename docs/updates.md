# 内核与桌面端独立更新

## 用户操作

应用菜单的更新项，或「设置 → 通用 → 软件更新」，打开独立更新窗口。窗口分别显示正在运行的 **dsh 内核** 和 **桌面端** 版本，各自检查、下载、安装；检查更新不会自动安装。

- **内核**包含整份 dsh、配套 WebUI、私有 Host、pnpm 及 Node/Python/Office 支持资源，不只是 npm 的顶层 `@deepseek-ai/dsh` 包。新版本下载到 Electron 用户数据目录的 `updates/kernels/<SHA256>/`，不需要 root。完整性、协议、数据兼容标识和 Node 版本检查通过后，在隔离 HOME/DSH_HOME 中试启动 Host；用户确认停止任务后，切换指针并重启桌面进程。重启进程不升级 Electron 软件包。
- **桌面端**下载当前系统安装格式的 deb 或 rpm；用户确认后停止任务，经 Polkit 图形认证运行固定的系统 `apt-get` / `dnf`。安装器将下载文件复制到 root 私有临时目录，再次校验摘要、包名、版本和架构，避免使用用户可修改的安装文件。未系统安装的解包版不能自行提权安装。
- **互不覆盖**：桌面软件包只写安装目录。启动时优先采用不低于捆绑基线、且兼容的用户内核；桌面候选若不支持当前内核，会被拒绝，而不是把内核降级。初始内核版本由 `upstream.json` 固定，桌面版本独立保存在 `desktop.json`。

更新窗口关闭不清除内核、会话或配置。内核下载、校验、探测或用户取消失败时，活跃指针不变。新内核启动期间有持久化的 `staged → booting → healthy` 状态；实际 Host 启动失败会回退一次，若进程在健康确认前中断，下次启动恢复上一个内核。

**回滚只涉及内核版本，不是用户数据库快照。** `dataEpoch` 必须完全匹配；发布者只有确认新旧内核的数据格式双向兼容后，才能沿用这个标识并签名发布。改变会话数据格式的版本必须更换 `dataEpoch`，本更新链会拒绝自动切换。健康确认表示 Host 与初始应用接口可用，不保证模型服务或所有插件正常。

## 配置独立发布源

仓库的 `updates.json` 已固定两个 GitHub 更新清单地址与 Ed25519 公钥：清单来自本仓库的 `update-feed` 分支，安装包来自版本化 GitHub Releases。首次发布成功前，地址尚无清单，不能声称更新源已上线。旧安装包仍使用打包时的配置，不会自动读取源码目录的配置。未配置的私有部署仍可将通道设为 `null`；应用不会静默信任从服务器返回的新密钥。

“官方内核”指复用 `upstream.json` 固定的官方源码进行 Linux 适配，由本项目构建、签名分发，不是官方托管的 Linux 更新服务。目前核实的官方更新通道仅提供 macOS/Windows 完整桌面包，不能直接当成这里的独立 Linux 内核包；仅安装 npm 的 dsh 也不包含完整桌面私有 Host 与配套运行时。

发布者为两个通道分别配置 HTTPS feed URL 和 Ed25519 公钥，可共用或分开密钥：

```json
{
  "kernel": {
    "url": "https://your-update-host.example/kernel-latest.json",
    "publicKey": "-----BEGIN PUBLIC KEY-----\n<your Ed25519 public key>\n-----END PUBLIC KEY-----\n"
  },
  "desktop": {
    "url": "https://your-update-host.example/desktop-latest.json",
    "publicKey": "-----BEGIN PUBLIC KEY-----\n<your Ed25519 public key>\n-----END PUBLIC KEY-----\n"
  }
}
```

这是格式示例，域名和密钥不是可用的发布源。正式发行前编辑根目录 `updates.json` 并重新打包。受控测试或私有部署也可将 `DSH_WORKBENCH_UPDATE_CONFIG` 设置为本机配置文件的绝对路径；**更换该文件的公钥就是更换信任来源**，只能使用自己信任的发布者。已安装用户内核的启动校验仍需要保留对应通道的可信公钥。

feed 和文件必须使用无 URL 凭据的 HTTPS。GitHub Releases 的下载地址允许最多三次受限重定向：只能转向同仓库、同文件名的 Release 下载地址或 `release-assets.githubusercontent.com`，到达 CDN 后不再接受重定向；签名与摘要校验不变。其他更新源不接受重定向，代理/CDN 应提供最终下载地址。下载有超时、大小限制，归档拒绝绝对/穿越路径、软硬链接、设备和重复文件，并限制解包数量、总大小及压缩比。预检查与实际抽取都会验证每个归档条目；解包在限制堆内存的独立 Node 进程中同步完成，避免大量待写文件占用桌面进程内存。子进程失败不改变活跃内核。两套更新均拒绝低于当前版本的候选。

## 构建并签名更新文件

准备生产密钥是单独的发布操作，本项目不会自动生成或上传生产私钥。可在仓库外创建 Ed25519 私钥与公钥，私钥权限必须为 `0600`；不能放在不支持 Unix 权限的 NTFS/exFAT 源码盘。公钥写入应用配置；私钥只用于下面的离线签名工具，绝不随应用分发。

```sh
make prepare
node scripts/build-updates.mjs

# 先正常编译并准备完整内核：make package
node build/release-updates.mjs kernel \
  --input build/upstream/apps/desktop/.desktop-build/targets/linux-x64 \
  --output dist/kernel-release \
  --key /secure/location/kernel-signing.pem \
  --base-url https://your-update-host.example/releases/kernel-version/

# 桌面包完成验证后；desktop.json 必须声明目标桌面支持的 kernelRange/nodeVersion
node build/release-updates.mjs desktop \
  --deb dist/dsh-workbench-0.2.1-alpha.1-x64.deb \
  --rpm dist/dsh-workbench-0.2.1-alpha.1-x64.rpm \
  --output dist/desktop-release \
  --key /secure/location/desktop-signing.pem \
  --base-url https://your-update-host.example/releases/desktop-version/
```

工具只生成本地文件，不上传、不创建 Git tag、不推送。已有同名签名输出会拒绝覆盖。内核包包括 `kernel.json` 全量文件清单和 `dsh/`、`runtime/` 两棵目录；私有 Host 使用官方 descriptor 再验一次，支持运行时也由全量清单覆盖。由于需要匹配 Host 和 WebUI，不能把任意 npm `latest` 直接装到活跃内核目录。

签名封装为 `{ "payload": "<base64 JSON>", "signature": "<base64 Ed25519>" }`，签名覆盖 payload 原始字节。payload 含版本、通道、平台、架构、Host 协议、`dataEpoch`、桌面/Node 兼容范围，以及文件大小和 SHA-256；内核还含清单摘要，桌面还含目标 Electron Node 版本及支持的内核范围。未通过签名校验的版本号、下载地址和兼容信息不参与安装决定。

## GitHub Actions 构建与发布

`.github/workflows/linux-updates.yml` 在推送 `main` 或手动触发时，复用 `make prepare → make test → make package`，只保存 Actions artifact，不发布。未配置签名 Secret 时仅生成 deb/rpm，明确跳过签名；配置后才生成完整 Linux 内核包及两个签名清单。缺少 Secret 的标签发布会在构建前被拒绝，不能发布未签名的更新源。私钥只传入签名步骤，写入 runner 私有临时文件，匹配 `updates.json` 中的公钥后才签名，并在步骤结束时删除；不会进入软件包或 artifact。

仓库管理员需要在 GitHub Actions Secrets 中配置 **`DSH_WORKBENCH_UPDATE_SIGNING_KEY`**，值为仓库外保存的 Ed25519 PEM 私钥。不要更换已有生产密钥来修复配置问题；更换公钥会改变用户信任来源，也会影响既有用户内核的启动校验。私钥必须离线备份，不能提交到 Git。首次配置可经批准后使用下列命令，命令不会显示私钥：

```sh
gh secret set DSH_WORKBENCH_UPDATE_SIGNING_KEY \
  --repo TommyFang2077/dsh-linux-desktop < /secure/location/update-signing.pem
```

仅用户明确推送 **`workbench-v<desktop.json 的 version>`** 标签时，才执行发布作业；本地脚本和普通 `main` 推送不自动创建标签。发布顺序是：通过全部构建与校验 → 创建不覆盖旧资产的 GitHub Release → 一次提交更新 `update-feed` 分支的两个清单。只有发布作业有 `contents: write` 权限；不强推分支、不覆盖同名 Release。预发布版本也使用固定 raw 清单地址，不依赖 GitHub 的 `releases/latest`（它排除预发布版本）。

更新官方版本时，先修改 `upstream.json` 的固定提交与版本，并验证协议、配套 WebUI/Host、Node 与数据格式兼容性；不能自动追踪未经验证的 npm `latest`。桌面版本单独修改 `desktop.json`，标签版本必须匹配。只有确认数据格式双向兼容后才能沿用 `dataEpoch`。

首次发布需单独授权上传生产密钥、推送源码与标签及对外发布。发布成功后再为旧安装包设置 `DSH_WORKBENCH_UPDATE_CONFIG` 或重新打包安装，并验证真实下载与签名；不能把“本地工作流校验通过”当成“更新源已上线”。

## 验证

```sh
make test                       # 含签名/兼容性/故障回滚/权限与提权安装器测试
make package                    # 编译与打包后验证真实 Host 和 Office 运行时
make gui-smoke                  # 隔离用户数据，检查真实桌面、设置更新入口和沙箱
make kernel-smoke               # 需要 openssl/Xvfb：临时HTTPS和签名，实际试启动、切换内核并重启
```

`kernel-smoke` 使用一次性 TLS/Ed25519 密钥和本地 HTTPS 服务，将当前内核复制为仅用于测试的新版载荷，驱动真实的下载、校验、Host 试启动、用户确认与重启，并断言内核版本变化而桌面版本不变；它不伪装成上游正式发行版，不上传文件，结束后删除测试密钥和用户数据。GUI 测试会联网安装默认应用市场，但不配置模型凭据。

单元测试使用临时 Ed25519 密钥、内存 HTTPS 响应和临时内核，不连接发布服务、不请求真实模型。提权安装器通过复制/摘要/包元数据及固定命令参数测试，不实际执行 sudo、pkexec、apt 或 dnf；本机系统安装、管理员认证、网络发布和真实版本跨代升级需要在单独授权的发行验证环境执行。
