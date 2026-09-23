# @deepseek-ai/dsh-status-plugins

[English](README.md) | 中文

通过 `ctx.statusPlugins`（[`StatusPluginsService`](src/index.ts)）实现按部署的插件启用。`/plugin` 命令切换一个非 group 的 loader entry：它先把一条按 id 定位的覆盖行追加到 home patch 层（`$DSH_HOME/cordis.patch.yml`，launcher 的全局用户 patch，被监听以实时重载），然后更新 loader entry 本身——插件 fiber 同步 dispose 或重新初始化。先持久化意味着写失败时 entry 保持原样；如果运行时应用失败，launcher 的 patch watcher 会在下次重载时重新应用该行，因此切换仍然生效。行携带 entry 的 config-row id（`options.id`，例如 `counting`），而不是带前缀的树 id（`include:counting`），因为 loader 的 patch 算法按前者匹配行。

一次已提交的切换会发出 `plugin/inventory-changed`（`{entryId, enabled}`），通过 api-remotes 白名单转发给客户端；消费方重新读取 `pluginInventory.list()` 以获取新状态。裸 `/plugin` 报告禁用集合；未知 id 与 group id 报错。

服务要求 `ctx.loader`；`/plugin` 命令是同一服务之上的可选子件。写目标遵循 launcher 的 `homePatchPath()` 约定（`join(resolveDshHome(), 'cordis.patch.yml')`），因此无需配置，每个 profile 都会组合该层。

## Model Experience

### Plugin enablement

#### What the model sees

切换插件会改变部署组合出的工具与 hooks：被禁用的插件的工具会在下一次 loader 重载后从后续请求的 schema 中消失。`plugin/inventory-changed` 是转发给客户端的通知，绝不对模型可见；`/plugin` 调用以常规的 `command/run` 生命周期事件记录在会话日志中。

#### Token effect

无直接 token 成本；面板不增加任何模型可见文本，被禁用的插件会从请求中移除它自己工具的 schema。

#### KV Cache effect

无直接失效；组合出的工具集属于请求前缀的一部分，因此请求前缀缓存必须以它为键（由组装 prompt 的消费方负责）。

## Known Limitations and Deferred Work

- **home patch 文件随每次切换增长**——行被追加（后行胜出）以保留用户文件内容；陈旧行无害但会累积。
- **插件卸载是即时的，但其工具在下次组装时才注销**——loader 同步 dispose fiber；模型的下一请求反映该变化。
- **只写 home（全局）patch 层**——按 profile 的切换目标在需要 profile 作用域写路径之前暂缓。
