# `@deepseek-ai/dsh-host-media-static`

English | [中文](README.zh.md)

Read-only media route for the Web shell: a function plugin (config `{routePrefix, mediaRoot}`) that registers a named prefix route on the [webserver](../webserver/README.md) and serves one configured directory (typically a generation output folder such as a ComfyUI `output/`) so the browser can fetch produced images and videos over HTTP. Existing files are served with their image/video MIME type; unknown extensions ship as `application/octet-stream`. A missing or non-file target returns an empty 404, the media root itself is not listable (a request for the directory path is 404), traversal outside the root returns 403, and non-GET/HEAD returns 405.

This is deliberately a *separate* named route from the SPA dist fallback ([`frontend-static`](../frontend-static/README.md)): the browser surface keeps the fallback's single-owner lock while media is served independently. [`dsh-web-app`](../../bundle/web-app/README.md) mounts this plugin only when both `mediaRoutePrefix` and `mediaRoot` are configured, so the surface ships without a media route by default.

The route is effect-scoped: disposing the plugin's fiber removes the route, after which the path falls through to the fallback (404 in the shipped composition).

## Model Experience

None, as the package serves browser media assets; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **The MIME table is minimal** — it covers common image and video extensions; other media types fall back to `application/octet-stream` until they actually ship.
- **No directory listing** — only concrete files are served; browsing the folder is out of scope by design.
