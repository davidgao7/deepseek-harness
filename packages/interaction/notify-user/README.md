# @deepseek-ai/dsh-notify-user

English | [中文](README.zh.md)

A hook plugin that fires a host desktop notification when the agent calls the existing `ask_user_question` tool, so the user notices the pending question even from another workspace. It joins the `tools/pre-execute` waterfall, extracts the first question's text, launches a best-effort `notify-send`, and delegates via `next()` so the question still proceeds normally. The plugin registers no tool, contributes nothing to model context, and is not a model-callable capability: it only observes a call the agent already makes.

## Behavior

On `tools/pre-execute`, the plugin does nothing unless the call is `ask_user_question` and `enabled` is true; every other call passes straight through to `next()` unchanged. For an intercepted call it reads `exec.arguments.questions` and takes the first entry's `question` field, falling back to its `header`; with no extractable text it still delegates and simply shows nothing. The notification is fire-and-forget: the `notify-send` child is spawned without waiting, and both synchronous spawn errors and the child's asynchronous `error` event (for example a missing binary) are swallowed, so a notification failure can never break the agent turn.

Setting `enabled: false` keeps the plugin loaded but makes it always delegate: no notification is ever fired. The `command` and `urgency` keys let a deployment point at a different notifier or urgency level.

## Config

| Key | Default | Meaning |
|---|---|---|
| `command` | `notify-send` | The executable that shows the notification. |
| `enabled` | `true` | When false, the plugin loads but never notifies and always delegates. |
| `urgency` | `critical` | The urgency flag value passed as `--urgency <value>`. |

```yaml
- id: notify-user
  name: '@deepseek-ai/dsh-notify-user'
```

## Model Experience

None, as this hook plugin registers no system-prompt section and no tool schema; it only observes the existing `ask_user_question` call on `tools/pre-execute` and fires a host desktop notification that never enters model context.

#### KV Cache effect

None; the plugin neither assembles nor sends a provider request, and the notification body never joins a request prefix.

## Known Limitations and Deferred Work

- **Best-effort delivery** — a missing `notify-send` binary, an absent notification daemon, or any other spawn failure is silently ignored, so a user away from the client can miss the question; the plugin never surfaces notification errors into the agent turn.
- **First question only** — a multi-question `ask_user_question` call notifies with the first question's text only; the remaining questions are not shown until the user returns to the client.
- **Freedesktop assumptions** — the default command is `notify-send`, a freedesktop/DBus utility; a macOS or Windows host must configure `command` to a compatible notifier.
