# @deepseek-ai/dsh-status-tools

[English](README.md) | 中文

通过 `ctx.statusTools`（[`StatusToolsService`](src/index.ts)）实现按会话的模型工具可见性。`/tool` 命令为调用它的 agent 切换一个全局工具：停用会在该 agent 的作用域上写入一条实时 deny 限制（该工具立即从该 agent 组装出的 schema 中消失），并把切换后的完整禁用集合记录为一条持久化的 `tools/restriction` 会话事件；启用则解除限制并记录缩减后的集合。折叠状态通过重放跨重启存活——新建的 agent（启动、恢复、HMR）在 `agent/created` 时重新应用它，因此强制从第一个请求起就生效。切换工具永远不会触碰全局注册表：其他会话照常看到该工具。

服务要求 `ctx.tools` 与 `ctx.agents`。挂载时对已存活的 agent 重新应用折叠，对之后创建的每个 agent 同样处理；工具已离开注册表的名字会被跳过（deny 仍留在折叠中，因此该工具重新注册时会被再次拒绝）。无法触达工具注册表的 agent 作用域在切换时大声失败。

两个可选子件在同一服务之上提供产品表面：`toolStatus` 会话投影单元（`src/types.ts` 声明 key；该单元折叠整体值限制事件，并在视图里给出每个当前已注册全局工具及其按会话的 `enabled` 标志，按名称排序——工具列表在读取时反映实时注册表，因此插件重载无需会话事件即可更新面板）与 `/tool` 命令（裸调用报告禁用集合；带工具名则切换它；未知名字报错）。每个子件只在对应注册表（`ctx.sessionProjections` / `ctx.commands`）被组合时激活。

## Model Experience

### Tools visibility

#### What the model sees

按会话的限制折叠会过滤该 agent 的可见工具集：被禁用的工具不会再出现在之后每次请求组装的工具 schema 中，因此模型无法调用它。`tools/restriction` 事件本身只是仅记录的用户意图。

#### Token effect

每个被禁用的工具都会把它的整个 schema（名称、描述、参数）从请求载荷中移除，按该工具 schema 的大小缩减组装的 prompt；投影面板不增加任何模型可见文本。

#### KV Cache effect

无直接失效；启用集合属于请求前缀的一部分，因此请求前缀缓存必须以它为键（由组装 prompt 的消费方负责）。

## Known Limitations and Deferred Work

- **面板反映全局工具注册表**——只在 agent 作用域注册的工具（按 agent 的 preset 影子注册）不会出现在 `toolStatus` 投影中；Web GUI 在全局组合工具。
- **会话中途的插件重载不会推送投影帧**——工具列表在视图读取时才计算，因此客户端要到下一个会话事件才看到新列表，而不是注册表变化的当下。
- **限制按 agent、折叠按会话**——同一会话 id 下存在两个存活 agent 不受支持（每个会话一个 agent 是 harness 不变量）。
