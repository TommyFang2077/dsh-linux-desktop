# dsh-linux-desktop

仓库：[TommyFang2077/dsh-linux-desktop](https://github.com/TommyFang2077/dsh-linux-desktop)。软件包名、可执行文件及既有数据目录保留 `dsh-workbench`，避免影响已安装版本与用户配置。

基于官方 [DeepSeek Harness Desktop](https://github.com/deepseek-ai/deepseek-harness/tree/master/apps/desktop) 的 **非官方 Electron Linux 桌面构建**，提供 x86_64 的 `.deb` 和 `.rpm`。直接复用官方主进程、WebUI、插件管理和 Host，不另写桌面壳。

支持系统托盘、默认应用市场，以及相互独立的内核／桌面更新机制。GitHub Actions 为本项目的 Linux 内核包与桌面包生成签名更新源；配置签名 Secret 并首次发布后才能使用。本项目不连接官方 macOS/Windows 桌面更新渠道，也不属于官方发行版。

官方内核源码版本和提交固定在 [`upstream.json`](upstream.json)，桌面版本及兼容范围独立保存在 [`desktop.json`](desktop.json)。当前基线为 `0.2.1-alpha.1` 开发预览版，可能存在破坏性变化。安装前阅读上游 [安全说明](https://github.com/deepseek-ai/deepseek-harness/blob/master/SAFETY.md)。

## 构建

需要 Linux x86_64、Node.js 22.19+ 或 24+（Node 23 不在支持范围内）、npm、Git、Python 3.11+、C/C++ 编译器、make、tar、`dpkg-deb`、`rpm` 和 `rpmbuild`。构建与测试不需要 root。

Ubuntu/Debian 可安装构建工具及 Electron 系统库：

```sh
sudo apt install build-essential git python3 rpm dpkg-dev libgtk-3-0 libnss3 libxss1 libxtst6 libgbm1 libasound2 libatspi2.0-0 xdg-utils
```

Ubuntu 24.04 中 GTK、ALSA、AT-SPI 的对应包名为 `libgtk-3-0t64`、`libasound2t64`、`libatspi2.0-0t64`。Fedora 可使用 `gcc-c++ make git python3 rpm-build dpkg gtk3 nss libXScrnSaver libXtst mesa-libgbm alsa-lib at-spi2-core xdg-utils`。

```sh
make prepare
make test
make package
```

首次构建会下载固定官方源码、pnpm、npm 依赖、Electron，以及官方锁定的 Node/Python/Office 运行时。需要联网和数 GB 的可用空间；源码、依赖和中间产物放在忽略的 `build/` 中。

也可分阶段执行：

```sh
make prepare                     # 下载源码、应用 Linux 补丁、安装锁定依赖
make build                       # 编译官方桌面端和 WebUI
python3 scripts/build.py package # 使用已有构建准备运行时并打包，不重新编译
python3 scripts/build.py bundle  # 使用已准备的运行时重新生成安装包
make verify                      # 核对两个安装包的身份、文件清单，生成 SHA256SUMS
make run                         # 将 deb 临时解包到 /tmp 并运行，不安装到系统
make gui-smoke                   # 可选：需要 Xvfb，使用隔离数据验证欢迎页 → 工作区
```

产物位于 `dist/`：`dsh-workbench-<version>-x64.deb`、`dsh-workbench-<version>-x64.rpm`、`SHA256SUMS` 和 `build-info.json`。打包始终在 Linux `/tmp` 下的私有目录暂存，校验完成后仅复制安装包到 `dist/`；因此源码目录位于 NTFS/exFAT 时，也不会将 `777` 权限写入安装包。打包命令会运行官方运行时检查与隔离数据目录的 Host 启动检查，拒绝非符号链接文件的组/其他用户可写权限，失败则停止，不将构建报告为验证通过。

## 安装

```sh
sudo apt install ./dist/dsh-workbench-0.2.1-alpha.1-x64.deb
# 或在 Fedora/RHEL 系使用：
sudo dnf install ./dist/dsh-workbench-0.2.1-alpha.1-x64.rpm
```

覆盖安装前先彻底退出正在运行的应用（新版可从托盘选择「退出」），不要只关闭窗口；安装完成后重新打开，避免继续使用被替换的旧进程。覆盖相同版本号的旧测试包时，使用 `apt install --reinstall ./包名.deb` 或 `dnf reinstall ./包名.rpm`。正式发布桌面更新前需单独提高 `desktop.json` 的版本；内核版本无需随之变化。

应用菜单名称和命令为 `dsh-workbench`，应用安装在 `/opt/dsh-workbench`。无需另装 Node、pnpm 或 Python；仍需发行版提供的 Electron 图形系统库。桌面程序不以 root 运行，不使用 `--no-sandbox`。

## Linux 适配范围

- [`patches/linux.patch`](patches/linux.patch) 补充官方准备脚本中的 Linux x64 目标及 Electron 可执行文件路径，保留官方运行时完整性检查、Host 启动和关闭流程。Linux 后端使用所选内核自带的独立 Node（当前基线为 24.21.0），不在 Electron Node 模式中加载 sharp；候选内核探测及失败回滚使用各自对应的 Node。打包检查覆盖 1×1 图片缩放、原生依赖、真实 Host 通信及正常退出，无需新增运行时依赖。
- [`electron-builder.config.mjs`](electron-builder.config.mjs) 复用官方文件收集与校验钩子，增加 deb/rpm、独立包名、应用 ID、图标及系统依赖。Linux 使用普通应用目录而非 ASAR，避免 Electron 44 将不存在的原生 Office 包误判为已安装，并允许捆绑的 WASM 引擎正常回退、访问实际文件。
- 使用独立的 `dsh-workbench` 名称和 Electron 配置目录，图标使用固定上游版本的 dsh 图案；`resources/dsh.ico` 提供 16–256px 多尺寸 ICO，Linux 菜单与应用窗口使用同源 512px PNG。
- Linux 移除窗口顶部「应用 / Edit」菜单栏。系统托盘复用应用 PNG，提供「打开 dsh-workbench」和「退出 dsh-workbench」菜单；关闭主窗口后继续在后台运行，可从托盘或应用图标恢复。桌面环境需支持系统托盘；GNOME 需启用兼容 Electron 新注册格式的 AppIndicator/KStatusNotifierItem 扩展（例如官方 v66，Ubuntu 24.04 自带 v58 不兼容）。安装包不会自动修改桌面扩展。
- 首次启动在官方管理的 `desktop` profile 中，通过官方插件管理器默认安装 `dshmarket 1.66.8` 应用市场（需要联网）。不强行豁免版本兼容检查；保留用户已有版本，用户之后卸载也不会再次强装。失败不阻塞桌面启动，更新窗口会显示提示，可在插件管理中重试。
- 不默认安装 TUI、旧 Tauri 语音、ModLens 或预设扩展。当前社区 TUI `0.12.0` 被官方管理器判为不兼容内核 `0.2.1-alpha.1`，因此未强装。Harness 数据仍按官方逻辑存储于 `~/.dsh`，卸载桌面包不删除这些数据。
- 普通插件安装在用户的 `~/.dsh/profiles/desktop`，不需要写入 `/opt`。`dsh-purge` 等直接修改内核文件的工具不等同于普通插件安装：系统内核由 root 管理，用户下载的内核也受完整性校验保护。定位环境变量只能解决路径识别，不能让运行期清洗安全生效；此类改动需要受支持的插件扩展点，或另行确认的构建阶段适配，并在修改后重新生成完整性描述与签名。
- 不注册官方 `dsh://` 协议或系统 `dsh` 命令，不绑定官方桌面更新源或强制更新服务。「设置 → 通用 → 软件更新」分别管理内核和桌面版本：内核在用户目录校验、试启动、切换和失败回滚，桌面 deb/rpm 通过系统授权安装且不覆盖兼容的新内核。
- 两个更新源已固定为本仓库 `update-feed` 分支的 HTTPS 签名清单与可信 Ed25519 公钥；首次发布前地址尚无清单。配置签名 Secret 后，GitHub Actions 从固定官方源码构建完整 Linux 内核和桌面 deb/rpm，分别签名；普通 `main` 推送或手动触发只生成 artifact，明确推送 `workbench-v<桌面版本>` 标签才发布 GitHub Release 并更新清单。配置、密钥保管和兼容性约束见 [独立更新说明](docs/updates.md)。
- 仅支持 Linux x86_64。生产私钥保存在仓库外，需经授权配置 GitHub Actions Secret；构建脚本不自动上传产物或创建 Git tag。

## 许可证

DeepSeek 名称和图案归各自权利人所有；使用上游图标不代表本项目获得官方背书。图标原图来自固定上游源码的 `apps/desktop/resources/icon-windows.svg`。

本项目构建脚本与 Linux 补丁采用 [MIT](LICENSE)。官方代码沿用上游 MIT 及第三方许可证；构建源码保留上游 `LICENSE` 和 `THIRD_PARTY_NOTICES.md`，捆绑的 Node、Python、Electron 及依赖沿用各自许可证。本项目不是 DeepSeek 官方发行版。
