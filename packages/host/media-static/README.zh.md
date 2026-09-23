# `@deepseek-ai/dsh-host-media-static`

[English](README.md) | 中文

Web 壳的只读媒体路由：一个函数插件（配置 `{routePrefix, mediaRoot}`），在 [webserver](../webserver/README.zh.md) 上注册一个命名前缀路由，并服务一个配置好的目录（通常是生成输出目录，如 ComfyUI 的 `output/`），使浏览器可以通过 HTTP 拉取生成的图片和视频。现有文件按其图片/视频 MIME 类型提供；未知扩展名以 `application/octet-stream` 提供。目标缺失或非文件时返回空 404，媒体根目录本身不可列出（对目录路径的请求返回 404），根目录之外的路径穿越返回 403，非 GET/HEAD 返回 405。

这与 SPA dist 回退（[`frontend-static`](../frontend-static/README.zh.md)）刻意是*独立*的命名路由：浏览器界面保持回退的唯一所有者锁，而媒体独立提供。[`dsh-web-app`](../../bundle/web-app/README.zh.md) 仅在同时配置了 `mediaRoutePrefix` 和 `mediaRoot` 时挂载此插件，因此界面默认不带媒体路由发布。

路由按 effect 作用域管理：dispose 插件 fiber 会移除该路由，此后该路径落到回退（在发布组合中为 404）。

## 模型体验

无，此包提供浏览器媒体资源；这里不触及任何模型请求。

#### KV 缓存影响

无；此包既不组装也不发送提供方请求。

## 已知限制与待办事项

- **MIME 表很精简** —— 覆盖常见图片和视频扩展名；其它媒体类型在实际使用前回退为 `application/octet-stream`。
- **无目录列表** —— 只提供具体文件；浏览文件夹按设计不在范围内。
