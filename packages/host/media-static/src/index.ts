/**
 * @deepseek-ai/dsh-host-media-static — read-only media route over the
 * webserver prefix table: serves one configured directory (typically a
 * generation output folder such as a ComfyUI `output/`) so the browser can
 * fetch produced images and videos over HTTP. Mirrors the frontend-static
 * traversal contract: a path that resolves outside the root is 403, absent
 * files 404, non-GET/HEAD 405, and known image/video extensions ship with
 * their MIME type (unknown ones as octet-stream). The root itself is not
 * listed — only concrete files are served, so a request for the directory
 * path is a 404.
 *
 * This is deliberately a *separate* named route from the SPA dist fallback,
 * so the browser surface never loosens the fallback's single-owner lock.
 * @module @deepseek-ai/dsh-host-media-static
 */

import type { ServerResponse } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { extname, join, normalize, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'

/** Stable Cordis plugin name. */
export const name = 'media-static'

/** Service required before the route can be claimed. */
export const inject = ['webServer']

/** Plugin config: the media directory anchor. */
export interface Config {
  /** URL pathname prefix (leading slash, no trailing slash) the route serves. */
  routePrefix: string
  /** Absolute path of the directory whose files are served. */
  mediaRoot: string
}

export const Config: z<Config> = z.object({
  routePrefix: z.string().required(),
  mediaRoot: z.string().required(),
})

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.ogg': 'video/ogg',
}

const MEDIA_MISS_CODES: ReadonlySet<string | undefined> = new Set([
  'ENOENT',
  'EISDIR',
  'ENOTDIR',
])

/** The media root itself is not listable — only concrete files are served. */
function isRoot(target: string, mediaRoot: string): boolean {
  return target === mediaRoot
}

/**
 * Serve one GET/HEAD media file from the configured root.
 * @param pathname - decoded URL pathname of the request.
 * @param res - the node:http response to write.
 * @param mediaRoot - absolute media root directory.
 * @returns whether the route claimed the request (false for a directory miss
 * that should fall through).
 */
export async function serveMedia(
  pathname: string, res: ServerResponse, mediaRoot: string,
): Promise<boolean> {
  const target = resolve(normalize(join(mediaRoot, pathname)))
  if (target !== mediaRoot && !target.startsWith(mediaRoot + sep)) {
    res.writeHead(403)
    res.end()
    return true
  }
  if (isRoot(target, mediaRoot)) {
    // Not a file: the route claims the path but answers 404 (no directory
    // listing is exposed).
    res.writeHead(404)
    res.end()
    return true
  }
  try {
    const info = await stat(target)
    if (!info.isFile()) {
      res.writeHead(404)
      res.end()
      return true
    }
    const body = await readFile(target)
    res.writeHead(200, { 'content-type': MIME[extname(target)] ?? 'application/octet-stream' })
    res.end(body)
  } catch (error) {
    if (!MEDIA_MISS_CODES.has((error as NodeJS.ErrnoException).code)) throw error
    res.writeHead(404)
    res.end()
  }
  return true
}

/**
 * Claim a webserver prefix route serving the media directory.
 * @param ctx - plugin context carrying the webServer service.
 * @param config - validated {@link Config}.
 */
export function apply(ctx: Context, config: Config): void {
  const mediaRoot = resolve(config.mediaRoot)
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: config.routePrefix,
    handler: async (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405)
        res.end()
        return
      }
      /* v8 ignore next -- node:http always sets url on server requests */
      const rawPath = new URL(req.url ?? '/', 'http://x').pathname
      const rel = decodeURIComponent(rawPath).slice(config.routePrefix.length)
      await serveMedia(rel || '/', res, mediaRoot)
    },
  }), 'media-static: route')
}
