# @deepseek-ai/dsh-status-plugins

English | [中文](README.zh.md)

Per-deployment plugin enablement through `ctx.statusPlugins` ([`StatusPluginsService`](src/index.ts)). The `/plugin` command toggles one non-group loader entry: it appends an id-targeted override row to the home patch layer (`$DSH_HOME/cordis.patch.yml`, the launcher's global user patch, watched for live reloads), then updates the loader entry itself — the plugin fiber disposes or re-initializes synchronously. Persisting first means a failed write leaves the entry untouched; if the runtime apply fails, the launcher's patch watcher re-applies the row on its reload, so the toggle still lands. The row carries the entry's config-row id (`options.id`, e.g. `counting`), not the prefixed tree id (`include:counting`), because the loader's patch algorithm matches rows by the former.

A committed toggle emits `plugin/inventory-changed` (`{entryId, enabled}`), forwarded to clients through the api-remotes allowlist; consumers refetch `pluginInventory.list()` for the new state. Bare `/plugin` reports the disabled set; unknown ids and group ids error.

The service requires `ctx.loader`; the `/plugin` command is an optional child over the same service. The write target follows the launcher's `homePatchPath()` convention (`join(resolveDshHome(), 'cordis.patch.yml')`), so no configuration is needed and every profile composes the layer.

## Model Experience

### Plugin enablement

#### What the model sees

Toggling a plugin changes which tools and hooks the deployment composes: a disabled plugin's tools disappear from subsequent request schemas on the next loader reload. `plugin/inventory-changed` is a client-forwarded notification, never model-visible; the `/plugin` invocation is recorded in the session log as the usual `command/run` lifecycle events.

#### Token effect

No direct token cost; the panel adds no model-visible text, and a disabled plugin removes its own tools' schemas from requests.

#### KV Cache effect

No direct invalidation; the composed tool set is part of the request prefix, so a request-prefix cache must key on it (owned by the consumer that assembles the prompt).

## Known Limitations and Deferred Work

- **The home patch file grows with every toggle** — rows are appended (later rows win) to preserve the user's file contents; stale rows are harmless but accumulate.
- **A plugin unload is immediate but its tools deregister on the next assembly** — the loader disposes the fiber synchronously; the model's next request reflects the change.
- **Only the home (global) patch layer is written** — a profile-specific toggle target is deferred until a profile-scoped write path is needed.
