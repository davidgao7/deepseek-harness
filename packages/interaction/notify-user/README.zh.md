# @deepseek-ai/dsh-notify-user

[English](README.md) | 中文

一个 hook 插件：当 agent 调用既有的 `ask_user_question` 工具时，在主机上触发桌面通知，让用户即使在其他工作区也能注意到待回答的问题。它加入 `tools/pre-execute` waterfall，提取第一个问题的文本，尽力启动 `notify-send`，然后通过 `next()` 委托放行，问题仍照常进行。该插件不注册任何工具，不向模型上下文贡献任何内容，也不是模型可调用的能力：它只观察 agent 已经发出的调用。

## 行为

在 `tools/pre-execute` 上，除非调用是 `ask_user_question` 且 `enabled` 为 true，否则插件不做任何事；其他所有调用原样通过 `next()` 放行。对被拦截的调用，它读取 `exec.arguments.questions`，取第一个条目的 `question` 字段，缺省时回退到 `header`；没有可提取的文本时它仍然放行，只是不显示任何通知。通知是 fire-and-forget 的：`notify-send` 子进程启动后不等待，同步的 spawn 错误和子进程异步的 `error` 事件（例如二进制缺失）都会被吞掉，因此通知失败绝不会破坏 agent turn。

设置 `enabled: false` 会让插件保持加载但始终放行：永远不会触发通知。`command` 与 `urgency` 键允许部署指向不同的通知器或紧急程度。

## Config

| 键 | 默认值 | 含义 |
|---|---|---|
| `command` | `notify-send` | 显示通知的可执行文件。 |
| `enabled` | `true` | 为 false 时插件加载但从不通知，始终放行。 |
| `urgency` | `critical` | 以 `--urgency <value>` 传递的紧急程度标志值。 |

```yaml
- id: notify-user
  name: '@deepseek-ai/dsh-notify-user'
```

## Model Experience

不适用，因该 hook 插件不注册任何 system-prompt section 或工具 schema；它只在 `tools/pre-execute` 上观察既有的 `ask_user_question` 调用并触发主机桌面通知，通知内容从不进入模型上下文。

#### KV Cache effect

无；该插件既不组装也不发送 provider 请求，通知正文从不加入请求前缀。

## Known Limitations and Deferred Work

- **尽力投递** —— `notify-send` 二进制缺失、通知守护进程不存在或任何其他 spawn 失败都会被静默忽略，因此离开客户端的用户可能错过问题；插件绝不会把通知错误带入 agent turn。
- **只通知第一个问题** —— 多问题 `ask_user_question` 调用只以第一个问题的文本通知；其余问题在用户回到客户端前不会显示。
- **Freedesktop 假设** —— 默认命令是 `notify-send`，一个 freedesktop/DBus 工具；macOS 或 Windows 主机必须把 `command` 配置为兼容的通知器。
