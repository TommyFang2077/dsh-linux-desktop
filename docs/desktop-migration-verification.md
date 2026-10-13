# 桌面整包升级验收记录

本记录对应 2026-10-13 的源码、构建与隔离验收。生产签名、更新源发布、真实 HOME 安装切换均未执行；用户操作与恢复步骤见 [整包迁移说明](desktop-migration.md)。

## 交付归档

| 归档 | 位置 | 字节数 | SHA-256 |
| --- | --- | ---: | --- |
| 官方 alpha.1 内核的 r8 桥接桌面 | `build/bridge-alpha1-r8/dist/dsh-workbench-0.2.1-alpha.1-r8-linux-x64.tar.gz` | 433725442 | `d6240cb15812d455c82e1061c5769b3a24dd9a5a44db32994adf6048bf18fd98` |
| 官方 alpha.2 内核的 r2 桌面 | `dist/dsh-workbench-0.2.1-alpha.2-r2-linux-x64.tar.gz` | 426180962 | `38553f26727fdca7bb4cb0e80f259623d7c48239572262431281e92f9de07a5c` |

两个实体归档内的独立 worker 均为 240776 字节、普通文件、模式 0755，SHA-256 为 `7d2ca3787fce23428199274beb8a321677b9dcaa1cef917326002062fa19f1fe`。alpha.1 与 alpha.2 的官方源码、内核和 dataEpoch 分别匹配，Host 协议为 4，Node 为 24.21.0，Electron 为 44.5.1；桥接包没有将 alpha.2 标记为 alpha.1。

构建与实体归档证据位于 `build/task19-archive-proof.json`、`build/task19-pipeline-info.json`。旧的 711e/e088 归档及 worker 0920 仅为历史中间结果，不属于本次交付。

## 真实升级与完整恢复

隔离事务 `696cb27a-09d9-4e9b-b62c-cd682f7c8678` 使用以上两个归档：冻结的真实 r7 更新器验证签名并安装 r8，实际 r8 UI/IPC 发起整包升级，实体 worker 等待旧 Electron 退出、完成备份，再启动实际 alpha.2 r2 及 Host。全部 HOME、DSH_HOME、XDG、TMP 路径均为私有临时目录。

| 时间，UTC | 已观测事件 |
| --- | --- |
| 06:13:42.374 | 原 Electron PID 93 已实际退出 |
| 06:14:38.721 | 完整备份 1591854482 字节验证成功 |
| 06:15:06.062 | 程序激活，启动新 Electron PID 347 |
| 06:15:09.301 | 新 Host PID 463 健康，随后实际窗口 ready |
| 06:16:25.580 | 完整恢复后实际 r8 PID 520 / Host 640 ready |

备份与恢复包含 516 个 DSH 条目、101 个 Electron userData 条目及 25918 个旧程序条目，共 26535 个条目。恢复前逐项核验内容摘要、模式、链接与完整清单；恢复后启动真实 r8，再通过公开接口读取旧数据。

公开读取的四条持久化记录为 `permission/preset`、`sandbox/mode`、`approval/policy`、`session/title`，seq 0–3。升级前、新桌面中、完整恢复后的 type、seq、time、data 逐项相同；自定义 `llm-deepseek` 用户设置及 `deepseek-flash` 的 `maxTokens: 257` 保留。两个官方版本的会话格式均为 4，本轮没有添加格式转换器。

## 写入者与恢复异常检查

同一正常事务中，两个外部进程保持关闭数据 FD 的根外硬链接映射：PID 297 为 `rw-p`，PID 298 为 `r--s`，均为 device 66306 / inode 2554008。其 PID、启动时间及 bootId 从准备前到新 Host 健康后不变，数据原字节保留；私有写映射与共享只读映射没有被误判。

另一个实体 UI/IPC 事务 `7f328a54-0a52-4062-b785-bef47d081945` 使用恢复后的真实 r8。PID 171 持有 `rw-s` 根外硬链接映射，device 66306 / inode 2686000，数据 FD 已关闭。实体 worker 报错 `Shared writer inspection failed or writer is active: Shared writable data mapping must be closed before migration: PID 171`，在已验证备份、激活及新程序启动之前停止。旧程序指针、安装状态与数据保留；释放该写入者后，真实旧 r8 再次健康，公开记录和设置仍相同。该结果来自映射检查，不是磁盘空间错误。

原 696c 事务的实体备份与复制的 worker 另通过 16 次公开 CLI 失败检查：五类角色交换、HOME 外路径、路径穿越、安装路径改向、链接逃逸各执行 verify/restore；三个 current/previous 状态改向各执行 verify/restore。每次退出 1，恢复目标保持未创建。随后恢复原清单字节并重新验证完整备份成功。

## 回归与审查

- 源码 `make test`：Python 16/16、外层 Node 92/92、实际非 root PID namespace 内 40/40，零跳过。留存的是原执行结果的捕获摘录，不是完整原始日志，也没有把小型合成归档测试称为实体归档验收。
- 两个源码配置分别执行公开 bundle、verify 及归档相关 13/13 检查，均退出 0；普通更新的签名、协议、Node、dataEpoch 检查保留。
- 独立 Standards 审查：硬性规范问题 0；仅有可选的低优先级受限 feed 读取逻辑重复建议。
- 独立 Spec 审查曾发现关闭 FD 的共享 mmap 别名漏检；修复后，调度者重放原失败用例，并独立断言以上新实体包正常链路、共享写负例及 16 次恢复异常检查，原 P1 已清除。

## 验收边界与发布交接

上述成功来自真实进程的隔离非 root namespace，不等同于默认宿主已具备完整写入者可观测性。默认宿主只读探测曾遇到 `/proc/1950/fd/0` 的 EACCES；该条件存在时，迁移仍停止，不跳过未知写入者。真实 HOME 的目录元数据 guard 保持不变；没有读取其生产数据或生产密钥内容。

本轮验证了非空会话元数据历史和用户设置，模型执行为 `performed: false`、`requests: []`，聊天生成场景没有专项验收。旧数据读取成功也不代表旧内核可读取 alpha.2 新写入的所有记录；恢复旧程序必须配套完整旧数据恢复。

全部自动备份与主要恢复证据保留。后续发布应使用上述冻结归档和既有发布脚本：legacy 更新源提供真实 r8，alpha.2 使用 epoch 专属更新源，先上传资产再更新已签名 feed；已安装 alpha.2 r1 的切源步骤单列在迁移说明中。生产签名、推送、发布及真实安装需要另行执行，不属于此次已完成的隔离验收。

临时原始证据位于 `/tmp/dsh-whole-desktop-smoke-8csQIR/whole-smoke-report.json`、`/tmp/dsh-task20-system-k63XnM/task20-evidence-index.json`；这些临时路径不作为长期发布资产。

验收现场只回收了明确自有、未进入原备份清单的负例下载副本及两份旧归档输入副本；所有 Backups、原始备份、完整恢复树、报告与 worker 均保留。结束时 `/tmp` 所在文件系统实际可用 1414311936 字节，后续完整大包验收需要重新核算容量；此数值是现场余量，不是升级所需容量。
