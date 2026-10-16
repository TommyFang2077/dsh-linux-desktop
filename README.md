# dsh-linux-desktop

基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 官方源码构建的**非官方 Linux 桌面版**，支持 Linux x86_64。

程序统一安装到 `~/Applications/dsh-linux-desktop/`，不安装到 `/opt`。升级保留现有配置、会话和插件。

## 安装

从 [Releases](https://github.com/TommyFang2077/dsh-linux-desktop/releases) 下载适合系统的软件包：

- **Ubuntu / Debian**：下载 `.deb`。
- **Fedora / RHEL**：下载 `.rpm`。

在下载目录打开终端，执行对应命令（文件名换成你下载的版本）：

```sh
# Ubuntu / Debian
sudo apt install ./dsh-workbench-0.2.1-alpha.2-r1-linux-x64.deb

# Fedora / RHEL
sudo dnf install ./dsh-workbench-0.2.1-alpha.2-r1-linux-x64.rpm
```

安装后，从应用菜单打开 **dsh-workbench**。首次启动会自动将程序安装到 HOME，请稍等；不需要手动解压，也不需要另外安装 Node.js 或 Python。

只有安装软件包需要系统授权，打开应用和应用内更新不需要。**不要使用 `sudo` 启动应用。** 从旧版升级前，请先通过托盘的「退出」完全关闭应用。

## 更新

打开 **设置 → 通用 → 软件更新**，检查并更新桌面或内核。两者独立更新，下载后会校验签名和兼容性。

自动更新实现已加入源码：启动完成后及每 6 小时后台检查、下载兼容更新，准备好后通知，安装必须由用户确认。Linux 补丁增加共享任务准入门禁，覆盖内部定时任务和未发布异步任务；忙、状态未知或旧 Host 不具备安全能力时拒绝安装，不强停任务。alpha.4 本地验收已完成：官方构建 9/9、冻结完整 Node 回归 170/170、后续烟测契约 14/14，以及 tar.gz/deb/rpm 校验、隔离 GUI 和临时签名内核升级烟测均通过。构建为分阶段修复恢复完成，失败历史保留；**线上 Actions、真实模型服务、生产签名发布及跨数据 epoch 迁移尚未验证**，详见[自动更新策略与维护](docs/automatic-updates.md)。跨数据格式迁移仍需手动检查与确认。源码改动不会自行升级当前已安装的旧应用。

仓库侧可以每 6 小时跟进官方正式/预发布 Release，创建升级 PR；只有精确版本兼容证据已受审查、构建测试通过时才自动合并和签名发布。未知兼容性转人工，默认不盲目追新。启用条件见 [自动更新策略与维护](docs/automatic-updates.md)。

**alpha.1 → alpha.2 是跨数据兼容边界升级**：在「软件更新」里点「检查更新」再点「更新」即可。alpha.1 用户会先更新到 `alpha.1 r9` 过渡包，再次更新时升级到 `alpha.2 r3`；旧应用完全退出、自动数据备份验证成功后才切换。仅更新 deb/rpm 引导包不会替换已有 HOME 版本；回退到 alpha.1 必须同时恢复旧格式数据。支持范围与恢复说明见 [过渡升级与恢复](docs/desktop-migration.md)。

托盘菜单提供「打开」「重启」「退出」。重启或退出前，如果有正在执行的任务，应用会请求确认。

## 常见问题

### 程序和数据放在哪里？

- 程序：`~/Applications/dsh-linux-desktop/`
- 配置、会话、插件和相关状态：实际 `DSH_HOME`，默认 `~/.dsh/`，桌面 profile 位于其 `profiles/desktop/`。
- 桌面设置：实际 Electron `userData`，默认 `~/.config/dsh-workbench/`；XDG 配置可能改变该路径。

不要通过删除数据目录来升级或迁移程序。

### GNOME 下没有托盘图标？

安装并启用适配当前 GNOME 版本的 **AppIndicator and KStatusNotifierItem Support** 扩展，只保留一个同类托盘扩展。优先使用 v66 或包含其修复的发行版版本；更换扩展后注销并重新登录，再启动应用。

应用不会自动修改系统扩展或关闭 Chromium 沙箱。

<details>
<summary>不使用 deb/rpm：手动安装 tar.gz</summary>

仅使用本仓库可信发行版或自己构建的归档。先核对下载来源和校验值，再执行其中的程序；未知来源的归档不能靠自己附带的校验值证明可信。

以下示例使用 r3 归档，在仓库根目录运行，归档位于 `dist/`：

```sh
(cd dist && sha256sum --check SHA256SUMS)
archive="$PWD/dist/dsh-workbench-0.2.1-alpha.2-r3-linux-x64.tar.gz"
checksum=$(sha256sum "$archive" | cut -d ' ' -f 1)
temporary=$(mktemp -d)
tar -xzf "$archive" -C "$temporary"
"$temporary/app/resources/runtime/primary-runtime/dependencies/node/bin/node" \
  "$temporary/app/resources/app/workbench/install-user.mjs" \
  --archive "$archive" --sha256 "$checksum" --version 0.2.1-alpha.2
~/.local/bin/dsh-workbench
```

安装完成后可删除临时解压目录。此方式同样安装到 HOME，之后从应用菜单启动和更新。

</details>

## 从源码构建

需要 Node.js 24+、npm、Git、Python 3.11+、C/C++ 编译器、make、tar、`dpkg-deb` 和 `rpmbuild`。首次构建需要联网和数 GB 空间。

```sh
make prepare
make test
make package
```

产物位于 `dist/`：deb、rpm、tar.gz、`SHA256SUMS` 和 `build-info.json`。

```sh
make verify      # 检查打包产物
make run         # 临时运行，不安装
make gui-smoke   # 使用隔离 HOME 验证窗口、图片和沙箱
```

上游版本固定在 `upstream.json`，Linux 构建号在 `desktop.json`，上游适配补丁在 `patches/linux.patch`。安装机制、签名发布和回滚详见 [更新说明](docs/updates.md)。

## 许可证

本项目构建脚本和 Linux 补丁采用 [MIT](LICENSE)，官方代码及捆绑依赖保留原许可证。DeepSeek 名称与图案归各自权利人所有，本项目并非 DeepSeek 官方发行版。
