# 会话无响应修复

基线：`v1.9.0` / `5b77f277`。本地分支：`fix/conversation-freeze`。

## 修复计划

1. 先用回归用例证明：外部任务监听会展开无关历史或大工具参数。
2. 用明确的运行生命周期字段替代整个消息对象的深监听；查询时仍读取最新回复、工具统计与审批状态。
3. 历史加载保留完整记录语义，增加完整记录和详情的累积预算、取消与调度让步，避免无界物化。
4. 大 JSON 解析如使用 worker，覆盖成功、解析失败、进程错误和取消后的释放。
5. 验证已有历史保存、续写、删除恢复、外部任务状态与构建边界，记录桌面验证结果。

## 成功标准

- 新文字或无关旧消息更新不会触发全历史深遍历和工具统计重算。
- 完成、停止、失败、提问、审批与恢复状态保持正确。
- 超大历史在拼接全部数据前明确失败，正常体积记录完整返回；失败不会作为部分记录保存。
- 异步读取或解析可取消，取消后的结果不会安装到当前会话。
- 相关回归、类型、静态检查和构建通过；桌面未覆盖项明确列出。

## 数据边界

只使用合成夹具验证。没有修改安装版、正在运行的任务或用户作品。数据库不做迁移。

现有控制器以完整消息数组维护持久化 ID 与位置，同时从完整数组恢复模型上下文。直接截取最近 N 条会破坏这两项约定，本次不采用这种改法。

## 验证结果

| 检查 | 结果 |
| --- | --- |
| 外部任务、桥接、并行运行、工具统计 | 4 文件 / 35 项通过 |
| Loader、Materializer、历史 Reader | 5 文件 / 47 项通过 |
| SQLite 恢复、百万字续聊、历史管理、持久化基线与注册表 | 6 文件 / 39 项通过 |
| `pnpm typecheck` | 全部 workspace 类型检查通过 |
| `pnpm lint` | ESLint、Renderer 边界、多语言检查通过 |
| `pnpm build` | 通过；application JS 1,230,061 B，小于原有 1,235,000 B 预算 |
| 桌面外部并行冒烟 | 五个独立会话、生成中创建、续跑与结果保留通过 |
| 构建产物 Worker 探针 | `file://`、正式 CSP、2 MiB 合成工具参数还原通过；创建和终止各 1 个 Worker |

共 121 项相关测试通过，包含新增回归与原有测试；没有运行全量测试集合。

## 最终实现

- `tracked-run.ts` 只观察身份、运行状态、错误、待输入与审批状态；正文、思考、工具参数和历史请求快照不再触发全历史深度遍历。状态查询仍读取最新回复与工具统计，终态冻结结果。
- 完整记录上限为 32 MiB，单详情实际流数据上限为 16 MiB。先检查可信声明，再累计实际 UTF-8 字节；消息、元数据聚合大小与单详情分别处理。
- 文本详情的声明大小可能包含 JSON 转义开销，因此按实际流字节限制；9 MiB 换行草稿及其更大的 JSON 上界有单独回归。
- 大详情在 Worker 拼接、解析；模块按需加载，成功、失败、取消、流异常和超限均清理。已有百万字续聊与完整保存语义保持不变。
- 458 MiB 合成会话在开始拉取详情前明确拒绝；约 15.7 MiB 的合成记录完整读取。没有把部分历史当作完整记录保存。

这是一项有界完整加载修复。真正的数据库分页界面尚未引入；超过预算的历史会话不能在当前完整记录控制器中打开，原数据保留。后续若要支持任意大历史，应一起改造部分加载状态、持久化完整 ID 基线和模型上下文读取。

## Windows Renderer 与界面验收

隐藏 Electron 窗口使用临时 profile 和合成数据。探针真实导入 `createTrackedMessages` 与 `trackExternalRun`，覆盖历史对象规模、流式更新、查询、终态、停止、错误、提问、审批、会话切换与移除。旧 payload getter 的读取次数为零。

真实 `AgentConversation` 组件使用 100 回合 / 200 条消息，核对流式更新、输入、手动上滚不被拉回，以及定位旧消息。隐藏窗口的 `requestAnimationFrame` 有明显降频，只能记录观测值，不能据此宣称前台帧率或长期真实模型生成通过。

过程截图：

1. [合成探针入口](2026-11-22-conversation-freeze/01-probe-entry.png)
2. [状态与 Worker 验证结果](2026-11-22-conversation-freeze/02-probe-results.png)
3. [真实组件流式生成](2026-11-22-conversation-freeze/03-conversation-streaming.png)
4. [上滚与旧消息定位](2026-11-22-conversation-freeze/04-conversation-navigation.png)

构建 Worker 原始结果：[built-worker-result.json](2026-11-22-conversation-freeze/built-worker-result.json)。

复跑：

```powershell
node apps/desktop/scripts/conversation-freeze-probe.mjs test/2026-11-22-conversation-freeze/renderer-probe.json
node test/2026-11-22-conversation-freeze/built-worker-probe.mjs
pnpm --filter @deepwrite/desktop smoke --external-concurrency-only
```

## 未覆盖与清理

- 未对用户正在使用的安装版打补丁，未用真实模型做长时间续写测试，未生成或安装发布安装包。
- 独立代码审查未发现剩余可行动问题。
- 旧失败探针的临时目录清理被自动审批拒绝，原始理由为 `rejected: blocked by policy`，没有更具体原因；未绕过该拒绝。涉及 `%LOCALAPPDATA%\Temp` 下 `deepwrite-freeze-profile-{5YAUMs,BBqYsO,j5Dbcu,K64EMo,UPmStn,v0cSrh,wzMy05}` 和 `deepwrite-freeze-probe-vite-qrU65b`。源码、构建和测试结果不受影响。
