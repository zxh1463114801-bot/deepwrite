# 历史会话列表恢复

## 目标与成功标准

活动历史超过加载预算或读取失败时，保留完整分页摘要；允许切换其他会话，不把未加载的原会话保存为空记录。

## 环境

Windows，DeepWrite 1.9.0。完整应用的隔离 profile、真实 Core SQLite 和合成 40 MiB 会话；未以真实作品作为写入夹具。

## 步骤与命令

- `pnpm exec vitest run apps/desktop/src/renderer/src/composables/conversationRegistryHistory.test.ts apps/desktop/src/renderer/src/composables/useConversationRuntimeRegistryCoordinator.test.ts apps/desktop/src/renderer/src/composables/useAgentConversation.history-management.test.ts`：28 项通过；新增用例修复前 2 项失败。
- `pnpm typecheck`、变更文件 ESLint / Prettier、`pnpm lint:boundary`、`pnpm lint:i18n`、`pnpm build`：通过。
- `exports/deepwrite-history-recovery-20261123/run-probe.mjs before|after`：相同 41,943,215 B 活动会话，修复前列表 0 条、修复后原有 3 条全部可见；可打开小会话，大会话再次失败不破坏当前状态和原记录。
- `exports/deepwrite-history-recovery-20261123/packaged-smoke.mjs`：安装版副本首次启动和重开均通过 Core、Faux Agent、会话持久化检查。
- 外置插件 `node --test D:/DWmcp/exports/deepwrite-history-recovery-20261123/plugin.test.cjs`：8 项通过；`run-probe.mjs plugin` 在原安装包、真实 Core、40 MiB 合成历史中通过相同列表和切换验收。

## 结果

修改 `conversationRegistryHistory.ts`、`useConversationRuntimeRegistryCoordinator.ts`、中英文提示，并新增回归测试。活动记录失败只进入独立恢复会话；521 条分页摘要保留，回退 ID 冲突受保护，持久化变更不含未加载会话或删除操作。

截图：[原列表为空](2026-11-23-history-list-recovery/01-before-empty-history.png)、[恢复完整列表](2026-11-23-history-list-recovery/02-after-history-list.png)、[打开已有会话](2026-11-23-history-list-recovery/03-opened-history.png)。

已通过个人插件通道部署 `history-list-recovery` 并正常重启；安装包替换被闲置 MCP 桥持有的文件锁拒绝，因此保留原 ASAR，未结束任何桥接进程。安装文件哈希、启用配置、MCP 就绪及作品读取通过；原资源包与插件启用配置均已备份。源代码修复和安装包候选保留在导出目录。

## 未覆盖与后续

单会话 32 MiB、单详情 16 MiB 的现有预算仍适用，超大记录保留在列表中但暂不能完整打开。本次修复列表可达性，不引入部分历史写回或提高预算；无真实模型生成测试。正式窗口被桌面工具错误识别，实际列表未截图确认；隔离完整应用截图见 [插件恢复列表](2026-11-23-history-list-recovery/04-plugin-history-list.png)。
