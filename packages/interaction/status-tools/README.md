# @deepseek-ai/dsh-status-tools

English | [中文](README.zh.md)

Per-session model-tool visibility through `ctx.statusTools` ([`StatusToolsService`](src/index.ts)). The `/tool` command toggles one global tool for the calling agent: disabling writes a live deny restriction on the agent's scope (the tool vanishes from that agent's assembled schemas immediately) and records the whole post-change disabled set as a durable `tools/restriction` session event; enabling lifts the restriction and records the reduced set. The fold survives restart by replay — a fresh agent (startup, resume, HMR) re-applies it on `agent/created`, so enforcement is live from the first request. Toggling a tool never touches the global registry: other sessions keep it.

The service requires `ctx.tools` and `ctx.agents`. It re-applies the fold to already-live agents on mount and to every later agent, skipping names whose tool left the registry (the deny stays in the fold, so a re-registration is denied again). An agent scope that cannot reach the tools registry fails loud on a toggle.

Two optional children ship the product surfaces over the same service: a `toolStatus` session-projection unit (`src/types.ts` declares the key; the unit folds the whole-value restriction events and views every currently registered global tool with its per-session `enabled` flag, sorted by name — the tool list reflects the live registry at read time, so a plugin reload updates the panel without a session event) and the `/tool` command (bare invocation reports the disabled set; a tool argument toggles it; an unknown name errors). Each child activates only when its registry (`ctx.sessionProjections` / `ctx.commands`) is composed.

## Model Experience

### Tools visibility

#### What the model sees

The per-session restriction fold filters the agent's visible tool set: a denied tool is absent from every subsequent request's assembled tool schemas, so the model cannot call it. The `tools/restriction` event itself is log-only user intent.

#### Token effect

Each denied tool removes its whole schema (name, description, parameters) from the request payload, shrinking the assembled prompt by that tool's schema size; the projection panel adds no model-visible text.

#### KV Cache effect

No direct invalidation; the enabled set is part of the request prefix, so a request-prefix cache must key on it (owned by the consumer that assembles the prompt).

## Known Limitations and Deferred Work

- **The panel reflects the global tool registry** — tools registered only in an agent scope (per-agent preset shadowing) do not appear in the `toolStatus` projection; the web GUI composes tools globally.
- **A plugin reload mid-session does not push a projection frame** — the tool list is read at view time, so the client sees the new list on the next session event, not the moment the registry changed.
- **The restriction is per-agent, the fold per-session** — two live agents on one session id are unsupported (one agent per session is the harness invariant).
