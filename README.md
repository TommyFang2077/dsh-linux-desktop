# dsh-linux-desktop

基于官方 [DeepSeek Harness Desktop](https://github.com/deepseek-ai/deepseek-harness/tree/master/apps/desktop) 源码的**非官方 Electron Linux 用户版**，直接复用官方内核、WebUI、私有 Host 与插件管理。仓库：[TommyFang2077/dsh-linux-desktop](https://github.com/TommyFang2077/dsh-linux-desktop)。

默认安装在 **`~/Applications/dsh-linux-desktop/`**，由当前用户所有，安装和桌面更新不需要 sudo，不使用 `/opt` 系统包安装。普通桌面归档不是 AppImage，只包含可解包的程序文件。软件包名、可执行文件、应用 ID 和既有配置身份仍保留 `dsh-workbench`，不会因为仓库改名或用户安装而重置数据。

## 构建

支持 Linux x86_64；构建需要 Node.js 24+、npm、Git、Python 3.11+、C/C++ 编译器、make 和 tar，默认不需要 dpkg/rpm/fpm。Electron 仍需要发行版的 GTK/NSS/GBM/ALSA 等图形库；归档自带应用所需的 Node/Python/Office 运行时，不另给用户安装宿主 Node/Python。

```sh
make prepare
make test
make package
```

官方内核源码由 `upstream.json` 固定；桌面版本和兼容范围独立保存在 `desktop.json`。桌面壳版本严格跟随所复用的官方壳源码，当前为 `0.2.1-alpha.1`，捆绑内核也为 `0.2.1-alpha.1` 开发预览版。Linux 适配单独使用 `linuxRevision`（当前 r1），不自行递增官方 alpha 编号；运行中的用户更新内核仍可独立升级。首次构建需要联网和数 GB 空间；生成的上游源码、依赖和中间产物在忽略的 `build/`，产物在 `dist/`：

- `dsh-workbench-<官方壳版本>-r<Linux构建号>-linux-x64.tar.gz`，唯一归档根为 `app/`
- `SHA256SUMS`
- `build-info.json`

打包在 Linux `/tmp` 私有目录内完成，保留用户可写和执行权限、清除特权及组/其他用户写权限，拒绝链接、特殊文件和穿越路径；所以源码放在 NTFS/exFAT 也不会把不安全权限带进归档。打包仍运行真实 Host、100 次图片缩放、Office 转换和完整性检查。

```sh
make build                       # 编译官方桌面和 WebUI
python3 scripts/build.py package # 复用已有编译，准备运行时与归档
python3 scripts/build.py bundle  # 复用已准备的运行时生成归档
make verify                      # 检查用户归档身份、权限、元数据和大小
make run                         # 验证后在临时目录试运行，不注册用户入口
make gui-smoke                   # 隔离 HOME 的真实窗口、图片和沙箱验证
```

## 安装在 HOME

**先验证来源，再执行下载的程序。** 对 CI 下载，核对仓库、提交和成功的 run，并按 GitHub artifact API 提供的 digest 验证下载 ZIP，再使用其中的 `SHA256SUMS` 验证桌面 tar；公开签名发行则使用固定受信公钥验证清单。未知来源的归档不能用它自己附带的校验值或运行时给自己背书。

下面的例子仅针对自己刚构建并校验的本地产物，或已经完成上述认证的归档。先在 `dist` 中检查摘要，再解包执行认证过的自带 Node 与安装入口；不需要 sudo：

```sh
(cd dist && sha256sum --check SHA256SUMS)
archive="$PWD/dist/dsh-workbench-0.2.1-alpha.1-r1-linux-x64.tar.gz"
checksum=$(sha256sum "$archive" | cut -d ' ' -f 1)
temporary=$(mktemp -d)
tar -xzf "$archive" -C "$temporary"
"$temporary/app/resources/runtime/primary-runtime/dependencies/node/bin/node" \
  "$temporary/app/resources/app/workbench/install-user.mjs" \
  --archive "$archive" --sha256 "$checksum" --version 0.2.1-alpha.1
~/.local/bin/dsh-workbench
```

实际安装布局为 `~/Applications/dsh-linux-desktop/versions/<归档摘要>/`，`current` 原子指向当前版本，`previous` 保留上一版本。用户命令是 `~/.local/bin/dsh-workbench`，菜单入口在用户 applications 目录的 `dsh-workbench.desktop`；图标来自用户程序树，不依赖系统包。安装器拒绝覆盖已有的无关命令、自定义桌面入口或未管理目录。

用户数据仍是既有 Electron `dsh-workbench` 配置目录和 `~/.dsh/profiles/desktop`，不会复制到程序版本目录，不会清空配置、会话或插件。首次迁移需要先完全退出旧应用，避免单实例锁把新入口转给旧进程。旧 `/opt` 系统包、系统命令和系统菜单入口不会被安装器改动；新用户版验证成功后，若需要卸载旧包，另行确认并执行包管理器操作。

安装或更新失败、取消确认、同步重启失败不会改动当前入口；旧版本保留，可显式使用安装入口的 `--rollback` 回退。首次 Electron 无法启动的自动回滚守护进程暂不提供。中断安装可能留下 `.install-lock`，只能确认没有安装进程后手工清理该空锁目录。

## 插件、桌面功能与更新

- Linux 后端使用所选内核自带的独立 Node（当前 24.21.0），不在 Electron Node 模式加载 sharp；候选内核探测和回滚也使用各自的 Node。
- Chromium 沙箱、上下文隔离和 Web 安全保持开启，不使用 `--no-sandbox`。系统不允许非特权 user namespace 时明确报错，不暗中修改安全策略。
- 移除顶部「应用 / Edit」菜单栏；系统托盘保留打开/退出操作。GNOME 需要兼容 Electron 注册格式的 AppIndicator/KStatusNotifierItem 扩展，程序不自动修改扩展。
- 首次启动通过官方插件管理器默认安装兼容的 `dshmarket 1.66.8`，保留用户已有版本、已卸载状态和配置；不会强装不兼容的 TUI。
- 普通插件安装在用户 profile。Host 暴露所选内核的真实路径，但用户拥有文件**不代表** `dsh-purge` 的磁盘补丁已兼容完整性检查；本次不会自动清洗、关掉审批或文件沙箱、伪装官方客户端或修改外部插件配置。
- 「设置 → 通用 → 软件更新」仍分内核和桌面：内核签名、兼容性、试启动和崩溃回滚逻辑不变；桌面更新安装用户归档、原子切换并明确重启到新 executable，不再执行 pkexec/apt/dnf，不把兼容的新内核降级。
- 更新 URL 和 Ed25519 公钥保存在 `updates.json`。GitHub Actions 的 main/手动构建只生成 artifact；配置签名 Secret 且明确推送 `workbench-v<官方壳版本>-r<Linux构建号>` 标签才签名并公开发行。未首次发布前清单可能为 HTTP 404，不能称为自动更新已上线。详见 [更新说明](docs/updates.md)。

所有上游改动保存在 `patches/linux.patch`；不直接修改已安装系统目录，不移动仓库外的生产签名密钥。GUI 是默认启动入口，不注册官方 `dsh://` 或占用系统 `dsh` 命令。

## 许可证

DeepSeek 名称与图案归各自权利人所有，复用图标不代表官方背书。本项目构建脚本和 Linux 补丁采用 [MIT](LICENSE)，官方代码及捆绑依赖保留原许可证和第三方声明。本项目不是 DeepSeek 官方发行版。
