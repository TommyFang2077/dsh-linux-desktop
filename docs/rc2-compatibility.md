# alpha.5 → rc.2 兼容性审核（2026-10-18）

结论：停止普通 OTA 发布。rc.2 的新 Web Search API 设置不能由 alpha.5 正常使用，不满足本轮要求的同纪元双向兼容。未添加 alpha.5 → rc.2 的 `compatible` 授权，未创建发布标签或推进更新清单。PR #36 保留为未审核候选。

## 精确审核对象

| 项目 | alpha.5 | rc.2 候选 |
| --- | --- | --- |
| 官方提交 | `1517a4dbca0a2789ff1d41ba439600f8547d23fa` | `687f282e8625c6b8d11ff58211a90524be2e4317` |
| 桌面版本 | `0.2.1-alpha.5` | `0.2.1-rc.2` |
| Linux revision | 2 | 3 |
| 数据纪元 | `dsh-0.2.1-alpha.4` | `dsh-0.2.1-rc.2` |
| Host 协议 / Node / pnpm | 4 / 24.21.0 / 11.28.5 | 沿用现有锁定配置；包验证另行执行 |

官方两个提交之间，`apps/desktop/src`、`apps/desktop-host/src`、`packages/core/session/src`、`packages/session/session-persistence/src`、`vendor/cordis/src`、`vendor/loader/src` 无源码差异。存储包仅版本号变化；根 pnpm 锁新增 workspace 依赖。Linux 补丁可完整应用到 rc.2。协议和运行时不变本身不能证明用户设置的双向兼容。

## 实测阻塞

rc.2 的 `packages/client/ui-settings-web-search/src/client/web-search-card-controller.ts` 中，`select(true)` 将以下值交给设置表单，`save()` 保存这些选择：

```json
{"searchProvider":"deepseek-search-api","fetchProvider":"deepseek-fetch-api"}
```

设置服务通过 Cordis profile patches 持久化配置。rc.2 在 `packages/bundle/base/cordis.patch.yml` 新增 `web-deepseek-api`；alpha.5 的默认 bundle 仅注册 `deepseek-official` 和 `http`。两版 `packages/web/web/src/index.ts` 对显式指定但未注册的 provider 均拒绝执行。

Node 24.21.0 源码契约探针结果：

| 配置 / 执行版本 | search | fetch |
| --- | --- | --- |
| alpha.5 默认设置 / alpha.5 | 通过 | 通过 |
| alpha.5 默认设置 / rc.2 | 通过 | 通过 |
| rc.2 新 API 设置 / rc.2 | 通过 | 通过 |
| rc.2 新 API 设置 / alpha.5 | `WEB_PROVIDER_CONFIGURED_MISSING` | `WEB_PROVIDER_CONFIGURED_MISSING` |

复现命令（在官方源码的独立 git checkout 中获取两个对象，不修改用户安装）：

```bash
git -C /path/to/upstream fetch --depth=1 https://github.com/deepseek-ai/deepseek-harness.git \
  1517a4dbca0a2789ff1d41ba439600f8547d23fa \
  687f282e8625c6b8d11ff58211a90524be2e4317
node scripts/check-rc2-compatibility.mjs /path/to/upstream
```

探针读取精确提交的实际设置选择方法和 WebRuntime 类，保留 provider 解析、配置读取与错误分支；Cordis 生命周期和 provider 网络 IO 使用替身。它证明一个具体的反向行为失败，不代表真实桌面、完整持久化往返或所有数据格式已验收。rc.2 的 `web/deepseek-search-llm-request.body.thinking` 是另一处变更；上游 `docs/persistence-changes/2026-10-13-deepseek-search-thinking.md` 声明为可选、仅日志字段，不能用这项声明覆盖上述 provider 问题。

## 自动跟进测试修复

配置测试按精确兼容策略判断数据纪元，并复用生产 `releaseFeedNames()` 校验清单名称，不再只允许 alpha。工作流回归分别验证未审核候选可构建与未授权发布被拒绝，覆盖 alpha、beta、rc、正式版本，以及错误迁移地址和非法数据纪元。生产签名、发布、兼容性门禁保持现有逻辑。

已用 Node 24.21.0 在隔离 rc.2 源码上复现原两项失败，修复后配置/工作流定向 4/4 通过；当前主线同一组 4/4 通过，Python 全量 41/41 通过。独立复审重跑兼容性探针，确认两个反向拒绝结果。完整包验证以最终候选 SHA 的 CI 记录为准，不把定向测试替代完整验收。

提交前对 rc.2 官方锁执行 `pnpm audit --prod`，报告上游既存 `http-cache-semantics@4.2.0` 高危公告 `GHSA-ch52-4w7c-c8xp` 与 `fflate@0.8.2` 中危公告 `GHSA-px8p-9vwx-vf98`，无 critical；alpha.5 锁也包含相同版本。本次无依赖改动，独立安全审查未发现新增安全边界缺陷；这些上游风险需在未来生产发布前单独处置，未复现其利用条件。

## 整包迁移方案（待验收，未发布）

1. 保留 rc.2 独立纪元和 `kernel-dsh-0.2.1-rc.2-latest.json` / `desktop-dsh-0.2.1-rc.2-latest.json`；alpha.5 的普通更新清单不指向 rc.2。不添加同纪元授权，也不把 rc.2 新配置静默改回旧默认值。
2. 在修复后的可信主线上刷新 PR #36，绑定最终候选 SHA；使用 Node 24 完成完整构建、项目测试、准入保护回归和 `.deb`、`.rpm`、`.tar.gz` 校验。候选成功不赋予自动发布资格。
3. 使用真实 alpha.5-r2 和 rc.2-r3 归档，在隔离 HOME、DSH_HOME、XDG 路径运行现有整包迁移入口；覆盖非空会话、自定义模型与 Web 设置、新 API 保存后的重新启动、任务忙时拒绝、用户取消、签名/摘要失败、备份失败和新 Host 健康失败。当前旧迁移烟测脚本的 alpha.1/alpha.2 身份断言需要先适配，不能直接将其结果记为本次升级验收。
4. 沿用 [整包迁移与恢复](desktop-migration.md) 的流程：用户确认、冻结任务准入、正常退出旧 Host/Electron、检查其他共享写入者、完整备份实际数据根和程序状态、验证备份、切换整包、确认新 Host 健康。失败恢复必须还原旧程序与同一快照的数据；只切回旧内核会遇到上述 provider 错误。
5. 整包验收通过后另行审核跨纪元发布和迁移源映射，绑定精确提交及证据；使用原有公钥完成签名资产上传和摘要复核，再推进独立纪元清单。为 alpha.5 客户端提供同信任公钥的显式 `desktopUpgrade` 配置，指向 rc.2 独立桌面源；先在隔离客户端验证发现、确认和恢复，再由用户在客户端确认本机迁移。不得改动现有 alpha.1/alpha.2 历史迁移源来强行引流。

本记录交付兼容性阻塞与迁移方案；不声称已经完成跨纪元迁移烟测或 rc.2 生产发布。
