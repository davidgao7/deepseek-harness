/**
 * REAL-composition coverage: a test-only cordis.yml booted through the
 * vendored Loader mounts the webserver and media-static rows, and every
 * assertion observes the served HTTP surface — image/video MIME types,
 * unknown-extension octet-stream, 404 misses, traversal rejection, 405 on
 * non-GET/HEAD, and route release on fiber disposal (HMR safety).
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import HttpServer from '@deepseek-ai/dsh-host-webserver'
import * as MediaStatic from '../src/index.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Write a media fixture and a two-row cordis.yml, then boot it through the real Loader. */
async function loadComposition(): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-media-static-'))
  const media = join(root, 'media')
  await mkdir(media)
  await writeFile(join(media, 'mommy_gen.png'), 'PNGDATA')
  await writeFile(join(media, 'clip.mp4'), 'MP4DATA')
  await writeFile(join(media, 'blob.bin'), 'BLOB')
  await mkdir(join(media, 'empty'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-host-webserver'",
    '  config:',
    "    host: '127.0.0.1'",
    '    port: 0',
    '- id: media',
    "  name: '@deepseek-ai/dsh-host-media-static'",
    '  config:',
    '    routePrefix: /media',
    `    mediaRoot: '${media}'`,
    '',
  ].join('\n'))

  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-host-webserver', HttpServer],
    ['@deepseek-ai/dsh-host-media-static', MediaStatic],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await context.loader.await()
  return context
}

/** GET (by default) one path against the running server; returns status, content-type, and a body prefix. */
async function request(port: number, path: string, init?: RequestInit): Promise<{ status: number; type: string | null; body: string }> {
  const response = await fetch(`http://127.0.0.1:${String(port)}${path}`, init)
  return {
    status: response.status,
    type: response.headers.get('content-type'),
    body: (await response.text()).slice(0, 80),
  }
}

describe('real Loader composition', () => {
  it('serves media files with image/video MIME types and error semantics', { timeout: 60_000 }, async () => {
    const loaded = await loadComposition()
    const unloaded = [...loaded.loader.entries()]
      .filter(entry => entry.fiber === undefined && !entry.disabled)
      .map(entry => entry.options.name)
    expect(unloaded).toEqual([])
    const port = loaded.webServer.port

    // Image and video files with their real MIME types; a live write is served on the next read.
    expect(await request(port, '/media/mommy_gen.png')).toMatchObject({ status: 200, type: 'image/png', body: 'PNGDATA' })
    expect(await request(port, '/media/clip.mp4')).toMatchObject({ status: 200, type: 'video/mp4', body: 'MP4DATA' })
    await writeFile(join(root!, 'media', 'mommy_gen.png'), 'PNGDATA2')
    expect(await request(port, '/media/mommy_gen.png')).toMatchObject({ status: 200, type: 'image/png', body: 'PNGDATA2' })
    expect(await request(port, '/media/clip.mp4', { method: 'HEAD' })).toEqual({
      status: 200,
      type: 'video/mp4',
      body: '',
    })

    // Unknown extension ships as octet-stream.
    expect(await request(port, '/media/blob.bin')).toMatchObject({ status: 200, type: 'application/octet-stream', body: 'BLOB' })

    // Directory root and directory path are not listed: 404.
    expect(await request(port, '/media')).toMatchObject({ status: 404 })
    expect(await request(port, '/media/empty')).toMatchObject({ status: 404 })

    // Missing files are empty 404s for both GET and HEAD.
    for (const path of ['/media/missing.png', '/media/no/such/file.png']) {
      const get = await request(port, path)
      const head = await request(port, path, { method: 'HEAD' })
      expect(get).toEqual({ status: 404, type: null, body: '' })
      expect(head).toEqual(get)
    }

    // Traversal outside the media root is 403. %2f-encoded slashes survive
    // the HTTP client's URL normalization and reach the handler intact; a
    // bare `../` segment is collapsed by the URL parser before the request.
    const traversal = ['/media/%2e%2e%2fpackage.json', '/media/..%2fsecret', '/media/%2e%2e%2f%2e%2e%2fetc%2fpasswd']
    for (const path of traversal) {
      expect((await request(port, path)).status).toBe(403)
    }

    // Non-GET/HEAD is 405.
    expect((await request(port, '/media/mommy_gen.png', { method: 'POST' })).status).toBe(405)
    expect((await request(port, '/media/mommy_gen.png', { method: 'PUT' })).status).toBe(405)
  })

  it('releases the media route on row fiber disposal', { timeout: 60_000 }, async () => {
    const loaded = await loadComposition()
    const port = loaded.webServer.port
    expect((await request(port, '/media/mommy_gen.png')).status).toBe(200)
    const mediaEntry = [...loaded.loader.entries()].find(e => e.options.id === 'media')
    expect(mediaEntry).toBeDefined()
    await mediaEntry!.fiber?.dispose()
    // Route released: the webserver answers 404 for the formerly claimed path.
    expect((await request(port, '/media/mommy_gen.png')).status).toBe(404)
  })
})
