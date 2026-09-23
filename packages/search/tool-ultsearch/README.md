# @deepseek-ai/dsh-tool-ultsearch

English | [中文](README.zh.md)

The model-facing `ultsearch` tool: query several independent web-search providers in PARALLEL and return results GROUPED per provider — never merged — so the model always knows which provider returned which results. This package owns the provider clients directly; it does NOT go through the [web capability seam](../../web/web/README.md) (`ctx.web`), which enforces single-provider selection. The five backends are Searlo (Google SERP), Exa, Tavily, Serper, and a self-hosted SearXNG instance driven through `docker compose`. Keys resolve from plugin config first, then the launch environment (`SEARLO_API_KEY`, `EXA_API_KEY`/`EXA_API`, `TAVILY_API_KEY`, `SERPER_API_KEY`, `SEARXNG_DIR`); a provider without a key reports itself as `not configured` in its own labeled output entry rather than failing the whole call. Every credentialed request uses `redirect: 'error'`, and error text reaching the model passes through `sanitizeError`, which redacts credential-bearing query parameters, `Authorization`/`X-API-KEY` header values, and Bearer tokens.

## Tools

| Tool | Args | Behavior |
|---|---|---|
| `ultsearch` | `query` (required string), `limit` (optional integer 1–8), `providers` (optional string[] of provider ids) | Queries every requested provider in parallel and returns one `{ provider, label, results, error? }` entry per provider, in query order. `Promise.allSettled` containment means one failing or unconfigured provider never breaks the others; each failure is a labeled entry with sanitized text. |

The tool opts into concurrent scheduling because provider reads return content without mutating parent-agent state.

The canonical tool value is `{ providers: [...] }` with per-provider `results: [{ title?, url, snippet? }]`; the model-facing render is one `### <provider> (<label>)` section per provider with `- [<title-or-hostname>](<url>) — <snippet>` lines, an `Error: <text>` line, or `No results found.`, ending with `Cite the relevant URLs above as markdown links in your answer.`

## Config

| Key | Default | Meaning |
|---|---|---|
| `limit` | `8` | Upper bound on results returned per provider in one call; also caps the model's `limit` argument. |
| `searloApiKey` | – | Searlo API key; falls back to `$SEARLO_API_KEY`. Blank → provider not configured. |
| `exaApiKey` | – | Exa API key; falls back to `$EXA_API_KEY` then `$EXA_API`. Blank → provider not configured. |
| `tavilyApiKey` | – | Tavily API key; falls back to `$TAVILY_API_KEY`. Blank → provider not configured. |
| `serperApiKey` | – | Serper API key; falls back to `$SERPER_API_KEY`. Blank → provider not configured. |
| `searxngDir` | – | Directory holding the SearXNG docker-compose project; falls back to `$SEARXNG_DIR`. Blank → provider not configured. |
| `searxngBaseUrl` | `http://localhost:8080` | SearXNG instance base URL; `/search?q=..&format=json&safesearch=0` is queried after `docker compose up -d` and torn down with `docker compose down` around each query. |

`limit` bounds the complete result: it is the per-provider result count sent to every backend (`num`, `numResults`, `max_results`, `num`), so one call returns at most `limit × providers` entries. The model-facing `limit` argument shares the same 1–8 bound as the config value; the schema exposes no other budget or timeout argument. Key values and `searxngDir` are trimmed before use; whitespace-only values count as unset.

```yaml
- id: tool-ultsearch
  name: '@deepseek-ai/dsh-tool-ultsearch'
```

## Model Experience

### System prompt

#### What the model sees

The tool contributes one guidance section at registration time.

##### Ultsearch guidance

```markdown
Use the ultsearch tool as your PRIMARY web-search tool for discovering current information. It queries multiple independent web-search providers in parallel and returns results grouped per provider. Pass one non-empty query; optionally set limit (1–8) to bound results per provider and providers to restrict which providers answer. Results are grouped per provider — treat each provider's results independently and cite the relevant URLs as markdown links. Prefer ultsearch over web_search: use it first for any search task.
```

#### Token effect

Fixed guidance cost per request. The section text is constant; only a code change alters it.

#### KV Cache effect

Prefix-stable while the section text is unchanged. Plugin lifecycle (re-registration) may invalidate reuse from the first changed prompt section; scoped tool restrictions do not remove the independently registered section.

### Tool schemas

#### What the model sees

The model sees the generated [`ultsearch` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-ultsearch) — one required `query` string, an optional `limit` integer, and an optional `providers` array restricted to the five provider ids (`searlo`, `exa`, `tavily`, `serper`, `searxng`). Result-count and provider budgets are deployment settings, not model arguments.

#### Token effect

Fixed schema cost per request. The provider-id enum and descriptions are constant.

#### KV Cache effect

Prefix-stable while the schema is unchanged. Plugin lifecycle may invalidate reuse from the first changed schema token.

### Search results

#### What the model sees

Each queried provider appears exactly once, labeled `### <provider> (<label>)` with data-dependent lines shaped exactly `- [<title-or-hostname>](<url>)`, optionally suffixed ` — <snippet>`. A provider with no usable results prints `No results found.`; a provider that was not queried is absent. Every result ends with `Cite the relevant URLs above as markdown links in your answer.` Entries are never merged or deduplicated across providers.

#### Token effect

Data-dependent results are resent until compaction; the complete result is bounded by `limit` per provider and by the `providers` restriction.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

### Provider failures

#### What the model sees

A provider without a key prints `Error: not configured: no <ENV_VAR>` (e.g. `no EXA_API_KEY`), SearXNG without a directory prints `Error: not configured: no SEARXNG_DIR`, and a failed or refused search prints `Error: <sanitized text>` — for example `Error: Searlo search failed: quota exceeded` or `Error: Searlo search failed (HTTP 500)`. Credential material in the error text is redacted to `[redacted]` before it reaches the model. All other providers keep their own successful entries; the call itself does not fail.

#### Token effect

Only the retained per-provider error lines add tokens; a failing provider costs no more than its labeled entry.

#### KV Cache effect

Append-only; the error follows the reusable request prefix and does not invalidate existing KV-cache entries.

### Argument errors

#### What the model sees

Schema validation rejects an absent or non-string `query`, a non-integer `limit`, and `providers` items outside the id enum before execution, as a structured `INVALID_ARGS` error. Value errors become exactly `Error: query must be a non-empty string`, `Error: limit must be a positive integer at most 8`, `Error: providers must contain at least one provider`, or `Error: unknown provider "<id>" (known: searlo, exa, tavily, serper, searxng)`.

#### Token effect

Only the failing call adds these retained tokens.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

- **SearXNG boot racing** — `docker compose up -d` returns before the SearXNG server listens, and the provider performs one immediate search fetch with no readiness retry, so a cold container can fail its first query with a per-provider error. Deployments should pre-warm the instance (the compose project stays up until the tool's `docker compose down` runs, so a second call within a session typically succeeds).
- **Sanitization is pattern-scoped** — `sanitizeError` redacts credential-bearing query parameters, `Authorization`/`X-API-KEY` header values, and Bearer tokens, but not a secret a provider echoes bare (for example `invalid api key sk-abc123`), because the raw secret value is not distinguishable from ordinary prose without a configured key to match against.
- **No cross-provider merging** — results are deliberately kept grouped per provider; a merged, deduplicated view (and the cross-provider agreement signal that implies) is deferred.
