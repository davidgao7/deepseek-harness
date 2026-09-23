# search/ —— 多 provider web 搜索工具

[English](README.md) | 中文

面向模型的多 provider web 搜索，刻意放在单一 provider 的 `ctx.web` seam 之外。`search` 组是纯容器，承载直接持有 provider client 的工具。

| 包 | 角色 | ctx key |
|---|---|---|
| [`tool-ultsearch/`](tool-ultsearch/README.zh.md) | 并行多 provider web 搜索，结果按 provider 分组 | registers on `ctx.tools` |

[web capability seam](../web/README.zh.md)（`ctx.web`）为每个能力只解析一个 provider；`ultsearch` 刻意绕过它，因为它的契约是跨多个 provider 的并行 fan-out，结果按 provider 分组并带标签。web seam Agent Note 记录了本组不扩展的单 provider 选择理由。
