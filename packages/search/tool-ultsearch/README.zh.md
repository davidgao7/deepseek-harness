# @deepseek-ai/dsh-tool-ultsearch

[English](README.md) | 中文

模型侧 `ultsearch` 工具：PARALLEL（并行）查询多个独立 web-search provider，并按 provider GROUPED（分组）返回结果 —— 绝不合并 —— 让模型始终知道哪条结果来自哪个 provider。本包直接持有 provider client；它不走 [web capability seam](../../web/web/README.zh.md)（`ctx.web`），因为该 seam 强制单 provider 选择。五个后端是 Searlo（Google SERP）、Exa、Tavily、Serper 与通过 `docker compose` 驱动的自托管 SearXNG 实例。密钥先从插件 config 解析，再读 launch environment（`SEARLO_API_KEY`、`EXA_API_KEY`/`EXA_API`、`TAVILY_API_KEY`、`SERPER_API_KEY`、`SEARXNG_DIR`）；没有密钥的 provider 在自己的带标签输出条目中报告为 `not configured`，而不是让整个调用失败。每个带凭证的请求都使用 `redirect: 'error'`，到达模型的错误文本都经过 `sanitizeError`，它会脱敏含凭证的查询参数、`Authorization`/`X-API-KEY` 头值与 Bearer token。

## 工具

| 工具 | 参数 | 行为 |
|---|---|---|
| `ultsearch` | `query`（必填 string）、`limit`（可选 integer 1–8）、`providers`（可选 provider id 的 string[]） | 并行查询每个请求的 provider，按查询顺序为每个 provider 返回一条 `{ provider, label, results, error? }` 条目。`Promise.allSettled` 隔离保证一个失败或未配置的 provider 绝不会破坏其他 provider；每个失败都是一条带净化文本的带标签条目。 |

该工具选择并发调度，因为 provider 读取返回内容而不改变 parent-agent 状态。

规范工具值是 `{ providers: [...] }`，带每个 provider 的 `results: [{ title?, url, snippet? }]`；模型侧渲染是每个 provider 一节 `### <provider> (<label>)`，含 `- [<title-or-hostname>](<url>) — <snippet>` 行、`Error: <text>` 行或 `No results found.`，以 `Cite the relevant URLs above as markdown links in your answer.` 结尾。

## Config

| 键 | 默认值 | 含义 |
|---|---|---|
| `limit` | `8` | 一次调用中每个 provider 返回结果数的上限；也限制模型的 `limit` 参数。 |
| `searloApiKey` | – | Searlo API key；回退到 `$SEARLO_API_KEY`。空白 → provider 未配置。 |
| `exaApiKey` | – | Exa API key；回退到 `$EXA_API_KEY` 再 `$EXA_API`。空白 → provider 未配置。 |
| `tavilyApiKey` | – | Tavily API key；回退到 `$TAVILY_API_KEY`。空白 → provider 未配置。 |
| `serperApiKey` | – | Serper API key；回退到 `$SERPER_API_KEY`。空白 → provider 未配置。 |
| `searxngDir` | – | 存放 SearXNG docker-compose 项目的目录；回退到 `$SEARXNG_DIR`。空白 → provider 未配置。 |
| `searxngBaseUrl` | `http://localhost:8080` | SearXNG 实例 base URL；每次查询先 `docker compose up -d`，查询 ` /search?q=..&format=json&safesearch=0`，再 `docker compose down` 拆除。 |

`limit` 约束完整结果：它是发送给每个后端的每 provider 结果数（`num`、`numResults`、`max_results`、`num`），因此一次调用最多返回 `limit × providers` 条条目。模型侧 `limit` 参数与 config 值共用 1–8 的同一上限；schema 不暴露其他预算或超时参数。键值与 `searxngDir` 使用前会 trim；纯空白值视为未设置。

```yaml
- id: tool-ultsearch
  name: '@deepseek-ai/dsh-tool-ultsearch'
```

## Model Experience

### System prompt

#### What the model sees

该工具在注册时贡献一个引导 section。

##### Ultsearch guidance

```markdown
Use the ultsearch tool as your PRIMARY web-search tool for discovering current information. It queries multiple independent web-search providers in parallel and returns results grouped per provider. Pass one non-empty query; optionally set limit (1–8) to bound results per provider and providers to restrict which providers answer. Results are grouped per provider — treat each provider's results independently and cite the relevant URLs as markdown links. Prefer ultsearch over web_search: use it first for any search task.
```

#### Token effect

每请求固定引导开销。section 文本恒定；只有代码改动才会改变它。

#### KV Cache effect

section 文本不变时前缀稳定。插件生命周期（重新注册）可能使从此变更的 prompt section 起的缓存复用失效；作用域工具限制不会移除独立注册的 section。

### Tool schemas

#### What the model sees

模型会看到生成的 [`ultsearch` schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-ultsearch) —— 一个必填 `query` string、一个可选 `limit` integer 与一个限制为五个 provider id（`searlo`、`exa`、`tavily`、`serper`、`searxng`）的可选 `providers` 数组。结果数与 provider 预算是部署设置，不是模型参数。

#### Token effect

每请求固定 schema 开销。provider-id enum 与描述恒定。

#### KV Cache effect

schema 不变时前缀稳定。插件生命周期可能使从此变更的 schema token 起的缓存复用失效。

### Search results

#### What the model sees

每个被查询的 provider 恰好出现一次，标记为 `### <provider> (<label>)`，数据相关行形状严格为 `- [<title-or-hostname>](<url>)`，可选后缀 ` — <snippet>`。没有可用结果的 provider 打印 `No results found.`；未被查询的 provider 不出现。每条结果都以 `Cite the relevant URLs above as markdown links in your answer.` 结尾。条目绝不跨 provider 合并或去重。

#### Token effect

数据相关结果在 compaction 前会被重发；完整结果受每个 provider 的 `limit` 与 `providers` 限制约束。

#### KV Cache effect

Append-only；新可见内容跟在可复用请求前缀之后，不会使既有 KV-cache 条目失效。

### Provider failures

#### What the model sees

没有密钥的 provider 打印 `Error: not configured: no <ENV_VAR>`（例如 `no EXA_API_KEY`），没有目录的 SearXNG 打印 `Error: not configured: no SEARXNG_DIR`，失败或被拒绝的搜索打印 `Error: <sanitized text>` —— 例如 `Error: Searlo search failed: quota exceeded` 或 `Error: Searlo search failed (HTTP 500)`。错误文本中的凭证材料在到达模型前被脱敏为 `[redacted]`。其他 provider 保留各自成功的条目；调用本身不失败。

#### Token effect

只有保留的每 provider 错误行增加 token；失败的 provider 至多消耗其带标签条目的开销。

#### KV Cache effect

Append-only；错误跟在可复用请求前缀之后，不会使既有 KV-cache 条目失效。

### Argument errors

#### What the model sees

Schema 校验会在执行前拒绝缺失或非 string 的 `query`、非 integer 的 `limit`，以及 id enum 之外的 `providers` 条目，作为结构化 `INVALID_ARGS` 错误。值错误精确变为 `Error: query must be a non-empty string`、`Error: limit must be a positive integer at most 8`、`Error: providers must contain at least one provider` 或 `Error: unknown provider "<id>" (known: searlo, exa, tavily, serper, searxng)`。

#### Token effect

只有失败的调用增加这些保留 token。

#### KV Cache effect

Append-only；错误跟在可复用请求前缀之后，不会使既有 KV-cache 条目失效。

## Known Limitations and Deferred Work

- **SearXNG 启动竞态** —— `docker compose up -d` 在 SearXNG server 开始监听前返回，provider 只做一次立即的搜索 fetch、无就绪重试，因此冷容器可能以每 provider 错误失败首次查询。部署应预热实例（compose 项目在工具的 `docker compose down` 运行前保持在线，因此同一会话内的第二次调用通常成功）。
- **净化是模式范围的** —— `sanitizeError` 会脱敏含凭证的查询参数、`Authorization`/`X-API-KEY` 头值与 Bearer token，但不脱敏 provider 裸回显的密钥（例如 `invalid api key sk-abc123`），因为没有配置的密钥可对照时，无法把原始密钥值与普通文本区分开。
- **不做跨 provider 合并** —— 结果刻意按 provider 分组保留；合并、去重的视图（及其隐含的跨 provider 一致性信号）被推迟。
