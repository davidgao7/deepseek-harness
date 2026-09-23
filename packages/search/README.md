# search/ — multi-provider web-search tooling

English | [中文](README.zh.md)

Multi-provider web search for the model, kept outside the single-provider `ctx.web` seam. The `search` group is a pure container for the tool that owns its provider clients directly.

| Package | Role | ctx key |
|---|---|---|
| [`tool-ultsearch/`](tool-ultsearch/README.md) | Parallel multi-provider web search with per-provider grouped results | registers on `ctx.tools` |

The [web capability seam](../web/README.md) (`ctx.web`) resolves exactly one provider per capability; `ultsearch` deliberately bypasses it because its contract is parallel fan-out across several providers with results grouped and labeled per provider. The web seam Agent Note records the single-provider selection rationale this group does not extend.
