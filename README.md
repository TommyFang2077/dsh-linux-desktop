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
sudo apt install ./dsh-workbench-0.2.1-alpha.1-r7-linux-x64.deb

# Fedora / RHEL
sudo dnf install ./dsh-workbench-0.2.1-alpha.1-r7-linux-x64.rpm
```

安装后，从应用菜单打开 **dsh-workbench**。首次启动会自动将程序安装到 HOME，请稍等；不需要手动解压，也不需要另外安装 Node.js 或 Python。

只有安装软件包需要系统授权，打开应用和应用内更新不需要。**不要使用 `sudo` 启动应用。** 从旧版升级前，请先通过托盘的「退出」完全关闭应用。

## 更新

打开 **设置 → 通用 → 软件更新**，检查并更新桌面或内核。两者独立更新，下载后会校验签名和兼容性。

托盘菜单提供「打开」「重启」「退出」。重启或退出前，如果有正在执行的任务，应用会请求确认。

## 常见问题

### 程序和数据放在哪里？

- 程序：`~/Applications/dsh-linux-desktop/`
- 配置、会话和插件：`~/.dsh/profiles/desktop/`
- 桌面设置：`~/.config/dsh-workbench/`

不要通过删除数据目录来升级或迁移程序。

### GNOME 下没有托盘图标？

安装并启用适配当前 GNOME 版本的 **AppIndicator and KStatusNotifierItem Support** 扩展，只保留一个同类托盘扩展。优先使用 v66 或包含其修复的发行版版本；更换扩展后注销并重新登录，再启动应用。

应用不会自动修改系统扩展或关闭 Chromium 沙箱。

<details>
<summary>不使用 deb/rpm：手动安装 tar.gz</summary>

仅使用本仓库可信发行版或自己构建的归档。先核对下载来源和校验值，再执行其中的程序；未知来源的归档不能靠自己附带的校验值证明可信。

以下示例在仓库根目录运行，归档位于 `dist/`：

```sh
(cd dist && sha256sum --check SHA256SUMS)
archive="$PWD/dist/dsh-workbench-0.2.1-alpha.1-r7-linux-x64.tar.gz"
checksum=$(sha256sum "$archive" | cut -d ' ' -f 1)
temporary=$(mktemp -d)
tar -xzf "$archive" -C "$temporary"
"$temporary/app/resources/runtime/primary-runtime/dependencies/node/bin/node" \
  "$temporary/app/resources/app/workbench/install-user.mjs" \
  --archive "$archive" --sha256 "$checksum" --version 0.2.1-alpha.1
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
