import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExecFileException } from 'node:child_process'
import { Context } from '@deepseek-ai/cordis'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import * as ToolUltsearch from '../src/index.ts'
import { resolveProviderKeys, resolveSearxngDir } from '../src/index.ts'
import {
  DEFAULT_RESULT_LIMIT,
  MAX_RESULT_LIMIT,
  PROVIDER_IDS,
  PROVIDER_LABELS,
  SEARXNG_DEFAULT_BASE_URL,
  errorText,
  formatGroupedOutput,
  parseArgs,
  runUltsearch,
  sanitizeError,
  type ProviderResultGroup,
  type RunUltsearchOptions,
} from '../src/ultsearch.ts'

// The SearXNG provider shells out to `docker compose`; unit tests stub it so
// no real container is ever started. The hoisted typed mock matches execFile's
// callback signature while returning a discarded ChildProcess placeholder.
type ExecFileCallback = (
  error: ExecFileException | null,
  stdout: string,
  stderr: string,
) => void
type ExecFileMock = (
  file: string,
  args: readonly string[],
  options: { cwd: string },
  callback: ExecFileCallback,
) => { on: () => unknown }

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn<ExecFileMock>() }))

vi.mock('node:child_process', () => ({ execFile: execFileMock }))

const testToolSignal = new AbortController().signal

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init })
}

/** Stub global fetch with a URL-keyed handler table; unexpected URLs fail loudly. */
function stubFetchByUrl(handlers: Record<string, () => Promise<Response> | Response>): ReturnType<typeof vi.fn> {
  const mock = vi.fn((input: RequestInfo | URL) => {
    const key = input instanceof URL ? input.href : typeof input === 'string' ? input : input.url
    const handler = handlers[key]
    if (handler === undefined) throw new Error(`unexpected fetch to ${key}`)
    return Promise.resolve(handler())
  })
  vi.stubGlobal('fetch', mock)
  return mock
}

/** Build a complete {@link RunUltsearchOptions} with all keys configured. */
function runOptions(overrides: Partial<RunUltsearchOptions> = {}): RunUltsearchOptions {
  return {
    query: 'hello world',
    limit: 5,
    providers: [...PROVIDER_IDS],
    keys: { searlo: 'sk', exa: 'ek', tavily: 'tk', serper: 'pk' },
    searxngBaseUrl: SEARXNG_DEFAULT_BASE_URL,
    signal: new AbortController().signal,
    ...overrides,
  }
}

/** Mount the real registries and tool-web; return an executor helper. */
async function mountTools(opts: { config?: ToolUltsearch.Config } = {}): Promise<{
  ctx: Context
  fiber: Awaited<ReturnType<Context['plugin']>>
  call: (name: string, args: unknown) => Promise<ToolExecutionResult>
}> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const fiber = await ctx.plugin(ToolUltsearch, opts.config ?? {})
  let counter = 0
  const call = (name: string, args: unknown) => ctx.tools.execute({ signal: testToolSignal, callId: ToolCallId(`call-${++counter}`), name, arguments: args })
  return { ctx, fiber, call }
}

beforeEach(() => {
  vi.resetAllMocks()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('sanitizeError', () => {
  it('redacts credential-bearing query parameters', () => {
    expect(sanitizeError('failed at https://x/search?q=hi&key=sk-1&api_key=sk-2&token=tk&x=1'))
      .toBe('failed at https://x/search?q=hi&key=[redacted]&api_key=[redacted]&token=[redacted]&x=1')
    expect(sanitizeError('failed at ...&apikey=SECRET&x=1')).toBe('failed at ...&apikey=[redacted]&x=1')
    expect(sanitizeError('apikey=SECRET')).toBe('apikey=SECRET')
  })

  it('redacts Authorization and X-API-KEY header values, quoted or bare', () => {
    expect(sanitizeError('Authorization: Bearer sk-abc')).toBe('Authorization: [redacted]')
    expect(sanitizeError('X-API-KEY: sk-9')).toBe('X-API-KEY: [redacted]')
    expect(sanitizeError('"authorization":"Bearer sk-zz"')).toBe('"authorization":"[redacted]"')
  })

  it('redacts Bearer tokens', () => {
    expect(sanitizeError('request rejected: Bearer sk-abc')).toBe('request rejected: Bearer [redacted]')
  })

  it('leaves ordinary error text unchanged', () => {
    expect(sanitizeError('Searlo search failed (HTTP 429)')).toBe('Searlo search failed (HTTP 429)')
  })
})

describe('parseArgs', () => {
  it('accepts a query with defaults, explicit limits, and provider restrictions', () => {
    expect(parseArgs({ query: 'hello' }, DEFAULT_RESULT_LIMIT)).toEqual({
      query: 'hello',
      limit: DEFAULT_RESULT_LIMIT,
      providers: [...PROVIDER_IDS],
    })
    expect(parseArgs({ query: 'hello', limit: 3 }, 8)).toEqual({
      query: 'hello',
      limit: 3,
      providers: [...PROVIDER_IDS],
    })
    expect(parseArgs({ query: 'hello', providers: ['exa', 'exa', 'serper'] }, 8)).toEqual({
      query: 'hello',
      limit: 8,
      providers: ['exa', 'serper'],
    })
  })

  it('rejects a blank or non-string query', () => {
    expect(() => parseArgs({ query: '  ' }, 8)).toThrow('query must be a non-empty string')
    expect(() => parseArgs({ query: 42 as unknown as string }, 8)).toThrow('query must be a non-empty string')
  })

  it.each([
    ['zero', 0],
    ['negative', -1],
    ['fractional', 1.5],
    ['oversized', MAX_RESULT_LIMIT + 1],
  ])('rejects a %s limit', (_label, limit) => {
    expect(() => parseArgs({ query: 'q', limit }, 8))
      .toThrow(`limit must be a positive integer at most ${MAX_RESULT_LIMIT}`)
  })

  it('rejects an empty provider list and unknown provider ids', () => {
    expect(() => parseArgs({ query: 'q', providers: [] }, 8)).toThrow('providers must contain at least one provider')
    expect(() => parseArgs({ query: 'q', providers: ['google'] }, 8)).toThrow('unknown provider "google"')
  })
})

describe('formatGroupedOutput', () => {
  it('renders per-provider sections with titles, snippets, and the citation footer', () => {
    const out = formatGroupedOutput([
      {
        provider: 'searlo',
        label: 'Searlo',
        results: [
          { title: 'A', url: 'https://a.test', snippet: 'about a' },
          { url: 'https://b.test' },
        ],
      },
    ])
    expect(out).toContain('### searlo (Searlo)')
    expect(out).toContain('- [A](https://a.test) — about a')
    expect(out).toContain('- [b.test](https://b.test)')
    expect(out).toContain('Cite the relevant URLs above as markdown links in your answer.')
  })

  it('renders errors and no-results per provider', () => {
    const out = formatGroupedOutput([
      { provider: 'exa', label: 'Exa', results: [], error: 'not configured: no EXA_API_KEY' },
      { provider: 'tavily', label: 'Tavily', results: [] },
    ])
    expect(out).toContain('### exa (Exa)\nError: not configured: no EXA_API_KEY')
    expect(out).toContain('### tavily (Tavily)\nNo results found.')
  })

  it('falls back to the raw URL when the URL is unparseable and omits empty snippets', () => {
    const out = formatGroupedOutput([
      { provider: 'serper', label: 'Serper', results: [{ url: 'not a url', snippet: '' }] },
    ])
    expect(out).toContain('- [not a url](not a url)')
    expect(out).not.toContain('—')
  })
})

describe('errorText', () => {
  it('formats Errors and arbitrary thrown values', () => {
    expect(errorText(new Error('boom'))).toBe('boom')
    expect(errorText('plain string')).toBe('plain string')
    expect(errorText(42)).toBe('42')
  })
})

describe('resolveProviderKeys', () => {
  const env = createLaunchEnvironmentSnapshot([
    {
      source: 'process',
      values: {
        SEARLO_API_KEY: 'env-searlo',
        EXA_API_KEY: 'env-exa',
        TAVILY_API_KEY: 'env-tavily',
        SERPER_API_KEY: 'env-serper',
      },
    },
  ])

  it('prefers config keys over the environment', () => {
    const keys = resolveProviderKeys({
      limit: 8,
      searxngBaseUrl: SEARXNG_DEFAULT_BASE_URL,
      searloApiKey: 'cfg-searlo',
      exaApiKey: 'cfg-exa',
      tavilyApiKey: 'cfg-tavily',
      serperApiKey: 'cfg-serper',
    }, env)
    expect(keys).toEqual({ searlo: 'cfg-searlo', exa: 'cfg-exa', tavily: 'cfg-tavily', serper: 'cfg-serper' })
  })

  it('falls back to the environment and skips blank config values', () => {
    const keys = resolveProviderKeys({
      limit: 8,
      searxngBaseUrl: SEARXNG_DEFAULT_BASE_URL,
      searloApiKey: '',
      exaApiKey: '  ',
    }, env)
    expect(keys).toEqual({ searlo: 'env-searlo', exa: 'env-exa', tavily: 'env-tavily', serper: 'env-serper' })
  })

  it('resolves the second env name when the first is blank', () => {
    const env = createLaunchEnvironmentSnapshot([
      { source: 'process', values: { EXA_API_KEY: '  ', EXA_API: 'exa-api-fallback' } },
    ])
    expect(resolveProviderKeys({ limit: 8, searxngBaseUrl: SEARXNG_DEFAULT_BASE_URL }, env))
      .toEqual({ exa: 'exa-api-fallback' })
  })

  it('leaves a provider unconfigured when neither layer supplies a key', () => {
    const emptyEnv = createLaunchEnvironmentSnapshot([{ source: 'process', values: {} }])
    expect(resolveProviderKeys({ limit: 8, searxngBaseUrl: SEARXNG_DEFAULT_BASE_URL }, emptyEnv)).toEqual({})
  })
})

describe('resolveSearxngDir', () => {
  const env = createLaunchEnvironmentSnapshot([{ source: 'process', values: { SEARXNG_DIR: '/env/searxng' } }])

  it('prefers config over the environment and trims values', () => {
    expect(resolveSearxngDir({ limit: 8, searxngBaseUrl: SEARXNG_DEFAULT_BASE_URL, searxngDir: ' /cfg/searxng ' }, env))
      .toBe('/cfg/searxng')
  })

  it('falls back to the environment', () => {
    expect(resolveSearxngDir({ limit: 8, searxngBaseUrl: SEARXNG_DEFAULT_BASE_URL }, env)).toBe('/env/searxng')
  })

  it('returns undefined when neither layer supplies a directory', () => {
    const emptyEnv = createLaunchEnvironmentSnapshot([{ source: 'process', values: {} }])
    expect(resolveSearxngDir({ limit: 8, searxngBaseUrl: SEARXNG_DEFAULT_BASE_URL, searxngDir: '  ' }, emptyEnv)).toBeUndefined()
  })
})

describe('runUltsearch', () => {
  it('queries every configured provider and groups results per provider', async () => {
    const fetchMock = stubFetchByUrl({
      'https://api.searlo.tech/api/v1/search/web?q=hello+world&num=5': () => jsonResponse({
        results: [
          { title: 'A', url: 'https://a.test', snippet: 'about a' },
          { url: 'https://b.test', description: 'about b' },
        ],
      }),
      'https://api.exa.ai/search': () => jsonResponse({
        results: [
          { title: 'E', url: 'https://e.test', text: 'exa snippet' },
          { url: 'https://f.test' },
        ],
      }),
      'https://api.tavily.com/search': () => jsonResponse({
        results: [{ title: 'T', url: 'https://t.test', content: 'tavily snippet' }],
      }),
      'https://google.serper.dev/search': () => jsonResponse({
        organic: [{ title: 'S', link: 'https://s.test', snippet: 'serper snippet' }],
      }),
    })
    const groups = await runUltsearch(runOptions({ providers: ['searlo', 'exa', 'tavily', 'serper'] }))
    expect(groups).toEqual([
      {
        provider: 'searlo',
        label: 'Searlo',
        results: [
          { title: 'A', url: 'https://a.test', snippet: 'about a' },
          { url: 'https://b.test', snippet: 'about b' },
        ],
      },
      {
        provider: 'exa',
        label: 'Exa',
        results: [
          { title: 'E', url: 'https://e.test', snippet: 'exa snippet' },
          { url: 'https://f.test' },
        ],
      },
      {
        provider: 'tavily',
        label: 'Tavily',
        results: [{ title: 'T', url: 'https://t.test', snippet: 'tavily snippet' }],
      },
      {
        provider: 'serper',
        label: 'Serper',
        results: [{ title: 'S', url: 'https://s.test', snippet: 'serper snippet' }],
      },
    ])
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it('sends credentialed requests with redirect: error and forwards the abort signal', async () => {
    const fetchMock = stubFetchByUrl({
      'https://api.searlo.tech/api/v1/search/web?q=hi&num=3': () => jsonResponse({ results: [] }),
      'https://api.exa.ai/search': () => jsonResponse({ results: [] }),
      'https://api.tavily.com/search': () => jsonResponse({ results: [] }),
      'https://google.serper.dev/search': () => jsonResponse({ organic: [] }),
    })
    const controller = new AbortController()
    await runUltsearch(runOptions({ query: 'hi', limit: 3, providers: ['searlo', 'exa', 'tavily', 'serper'], signal: controller.signal }))
    const calls = fetchMock.mock.calls as unknown as [string | URL, RequestInit][]
    expect(calls).toHaveLength(4)
    for (const [, init] of calls) {
      expect(init.redirect).toBe('error')
      expect(init.signal).toBe(controller.signal)
    }
    const [searloUrl, searloInit] = calls[0] as [string | URL, RequestInit]
    expect(String(searloUrl)).toBe('https://api.searlo.tech/api/v1/search/web?q=hi&num=3')
    expect((searloInit.headers as Record<string, string>)['x-api-key']).toBe('sk')
    const [, exaInit] = calls[1] as [string | URL, RequestInit]
    expect((exaInit.headers as Record<string, string>).authorization).toBe('Bearer ek')
    expect(JSON.parse(exaInit.body as string)).toEqual({
      query: 'hi',
      numResults: 3,
      contents: { text: { maxCharacters: 300 } },
    })
    const [, tavilyInit] = calls[2] as [string | URL, RequestInit]
    expect(JSON.parse(tavilyInit.body as string)).toEqual({
      api_key: 'tk',
      query: 'hi',
      max_results: 3,
      search_depth: 'basic',
    })
    const [, serperInit] = calls[3] as [string | URL, RequestInit]
    expect((serperInit.headers as Record<string, string>)['X-API-KEY']).toBe('pk')
    expect(JSON.parse(serperInit.body as string)).toEqual({ q: 'hi', num: 3 })
  })

  it('reports a provider without a key as not configured without failing the others', async () => {
    const fetchMock = stubFetchByUrl({
      'https://api.searlo.tech/api/v1/search/web?q=hello+world&num=8': () => jsonResponse({ results: [] }),
    })
    const groups = await runUltsearch(runOptions({ providers: ['searlo', 'exa'], keys: { searlo: 'sk' }, limit: 8 }))
    expect(groups).toEqual([
      { provider: 'searlo', label: 'Searlo', results: [] },
      { provider: 'exa', label: 'Exa', results: [], error: 'not configured: no EXA_API_KEY' },
    ])
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const none = await runUltsearch(runOptions({ providers: ['searlo'], keys: {} }))
    expect(none[0]).toEqual({ provider: 'searlo', label: 'Searlo', results: [], error: 'not configured: no SEARLO_API_KEY' })
  })

  it('reports HTTP errors with the provider detail and the HTTP status fallback', async () => {
    stubFetchByUrl({
      'https://api.searlo.tech/api/v1/search/web?q=hello+world&num=8': () => jsonResponse({ detail: 'quota exceeded' }, { status: 403 }),
      'https://api.exa.ai/search': () => jsonResponse({ error: 'invalid api key' }, { status: 401 }),
      'https://api.tavily.com/search': () => new Response('gateway down', { status: 502 }),
      'https://google.serper.dev/search': () => jsonResponse({ message: 'rate limited' }, { status: 429 }),
    })
    const groups = await runUltsearch(runOptions({ providers: ['searlo', 'exa', 'tavily', 'serper'], limit: 8 }))
    expect(groups.map(group => group.error)).toEqual([
      'Searlo search failed: quota exceeded',
      'Exa search failed: invalid api key',
      'Tavily search failed (HTTP 502)',
      'Serper search failed: rate limited',
    ])
  })

  it('falls back to the HTTP status for detail-less bodies and reports unparseable success bodies', async () => {
    stubFetchByUrl({
      'https://api.searlo.tech/api/v1/search/web?q=hello+world&num=8': () => jsonResponse({ foo: 'x' }, { status: 500 }),
      'https://api.exa.ai/search': () => new Response('null', { status: 500 }),
      'https://api.tavily.com/search': () => ({ ok: false, status: 503, text: () => Promise.reject(new Error('read failed')) }) as unknown as Response,
      'https://google.serper.dev/search': () => ({ ok: true, json: () => Promise.reject(new Error('bad json body')) }) as unknown as Response,
    })
    const groups = await runUltsearch(runOptions({ providers: ['searlo', 'exa', 'tavily', 'serper'], limit: 8 }))
    expect(groups.map(group => group.error)).toEqual([
      'Searlo search failed (HTTP 500)',
      'Exa search failed (HTTP 500)',
      'Tavily search failed (HTTP 503)',
      'bad json body',
    ])
  })

  it('sanitizes credential material in provider failure text', async () => {
    stubFetchByUrl({
      'https://api.searlo.tech/api/v1/search/web?q=hello+world&num=8': () =>
        Promise.reject(new Error('request failed: https://x/search?api_key=sk-secret&token=tk-1; Authorization: Bearer bt-2')),
    })
    const groups = await runUltsearch(runOptions({ providers: ['searlo'], limit: 8 }))
    expect(groups[0]?.error).toContain('api_key=[redacted]')
    expect(groups[0]?.error).toContain('token=[redacted]')
    expect(groups[0]?.error).toContain('Authorization: [redacted]')
    expect(groups[0]?.error).not.toContain('sk-secret')
    expect(groups[0]?.error).not.toContain('bt-2')
  })

  it('maps each provider response and drops unusable entries', async () => {
    stubFetchByUrl({
      'https://api.searlo.tech/api/v1/search/web?q=hello+world&num=8': () => jsonResponse({
        organic: [
          { title: 'O', url: 'https://o.test', snippet: 'organic snippet' },
          null,
          { url: '' },
        ],
      }),
      'https://api.exa.ai/search': () => jsonResponse({
        results: [
          null,
          { url: 123 },
          { url: '' },
          { url: 'https://hl.test', highlights: ['first highlight', 'second'] },
          { url: 'https://hl2.test', highlights: 'not-an-array' },
          { url: 'https://plain.test' },
        ],
      }),
      'https://api.tavily.com/search': () => jsonResponse({
        results: [
          { url: 'https://t.test', content: 'tavily text' },
          { title: 'X', url: 'https://x.test' },
          { title: '', url: 'https://t2.test', content: '' },
        ],
      }),
      'https://google.serper.dev/search': () => jsonResponse({
        organic: [
          { title: 'S', link: 'https://s.test', snippet: 'serper snippet' },
          { link: 7 },
        ],
      }),
    })
    const groups = await runUltsearch(runOptions({ providers: ['searlo', 'exa', 'tavily', 'serper'], limit: 8 }))
    expect(groups[0]?.results).toEqual([{ title: 'O', url: 'https://o.test', snippet: 'organic snippet' }])
    expect(groups[1]?.results).toEqual([
      { url: 'https://hl.test', snippet: 'first highlight' },
      { url: 'https://hl2.test' },
      { url: 'https://plain.test' },
    ])
    expect(groups[2]?.results).toEqual([
      { url: 'https://t.test', snippet: 'tavily text' },
      { title: 'X', url: 'https://x.test' },
      { url: 'https://t2.test' },
    ])
    expect(groups[3]?.results).toEqual([{ title: 'S', url: 'https://s.test', snippet: 'serper snippet' }])
  })

  it('tolerates malformed or empty response bodies without failing the provider', async () => {
    stubFetchByUrl({
      'https://api.searlo.tech/api/v1/search/web?q=hello+world&num=8': () => jsonResponse('not an object'),
      'https://api.exa.ai/search': () => jsonResponse({ results: {} }),
      'https://api.tavily.com/search': () => jsonResponse({}),
    })
    const groups = await runUltsearch(runOptions({ providers: ['searlo', 'exa', 'tavily'], limit: 8 }))
    expect(groups.map(group => group.results)).toEqual([[], [], []])
    expect(await runUltsearch(runOptions({ providers: [] }))).toEqual([])
  })

  it('runs SearXNG through docker compose up/down and maps its content field', async () => {
    execFileMock.mockImplementation((_file, _args, _options, callback) => {
      callback(null, '', '')
      return { on: () => undefined }
    })
    stubFetchByUrl({
      'http://localhost:8080/search?q=hello+world&format=json&safesearch=0': () => jsonResponse({
        results: [
          { title: 'SX', url: 'https://sx.test', content: 'searxng snippet' },
          { url: 'https://sx2.test' },
          null,
        ],
      }),
    })
    const groups = await runUltsearch(runOptions({ providers: ['searxng'], searxngDir: '/tmp/searxng' }))
    expect(groups[0]).toEqual({
      provider: 'searxng',
      label: 'SearXNG',
      results: [
        { title: 'SX', url: 'https://sx.test', snippet: 'searxng snippet' },
        { url: 'https://sx2.test' },
      ],
    })
    expect(execFileMock).toHaveBeenCalledTimes(2)
    const [upCall] = execFileMock.mock.calls
    expect(upCall?.[0]).toBe('docker')
    expect(upCall?.[1]).toEqual(['compose', 'up', '-d'])
    expect(upCall?.[2]).toEqual({ cwd: '/tmp/searxng' })
    const [downCall] = execFileMock.mock.calls.slice(1)
    expect(downCall?.[1]).toEqual(['compose', 'down'])
  })

  it('reports SearXNG compose up failures descriptively', async () => {
    execFileMock.mockImplementation((_file, _args, _options, callback) => {
      callback(new Error('docker daemon unreachable'), '', '')
      return { on: () => undefined }
    })
    const groups = await runUltsearch(runOptions({ providers: ['searxng'], searxngDir: '/tmp/searxng' }))
    expect(groups[0]?.error).toContain('SearXNG unavailable: docker compose up failed: docker daemon unreachable')
    expect(execFileMock).toHaveBeenCalledTimes(2)
  })

  it('swallows a failed SearXNG teardown and keeps the search outcome', async () => {
    execFileMock.mockImplementation((_file, args, _options, callback) => {
      if (args?.includes('up') ?? false) callback(null, '', '')
      else callback(new Error('down failed'), '', '')
      return { on: () => undefined }
    })
    stubFetchByUrl({
      'http://localhost:8080/search?q=hello+world&format=json&safesearch=0': () => jsonResponse({ results: [] }),
    })
    const groups = await runUltsearch(runOptions({ providers: ['searxng'], searxngDir: '/tmp/searxng' }))
    expect(groups[0]?.error).toBeUndefined()
    expect(groups[0]?.results).toEqual([])
  })

  it('reports SearXNG as not configured without SEARXNG_DIR', async () => {
    const groups = await runUltsearch(runOptions({ providers: ['searxng'] }))
    expect(groups[0]?.error).toBe('not configured: no SEARXNG_DIR')
    expect(execFileMock).not.toHaveBeenCalled()
  })
})

describe('tool registration', () => {
  it('registers ultsearch with parallel scheduling and prompt guidance, and unregisters on dispose', async () => {
    const { ctx, fiber } = await mountTools()
    const names = ctx.tools.schemas().map(schema => schema.name)
    expect(names).toContain('ultsearch')
    expect(ctx.tools.executionMode({ signal: testToolSignal, callId: ToolCallId('ult-safe'), name: 'ultsearch', arguments: { query: 'q' } }))
      .toEqual({ kind: 'parallel' })
    const prompt = await ctx.systemPrompt.assemble()
    expect(prompt.sections.map(section => section.text).join('\n'))
      .toContain('Use the ultsearch tool as your PRIMARY web-search tool')
    await fiber.dispose()
    expect(ctx.tools.schemas().map(schema => schema.name)).not.toContain('ultsearch')
  })

  it('has no default export (namespace plugin export shape)', () => {
    expect('default' in ToolUltsearch).toBe(false)
  })

  it.each([0, MAX_RESULT_LIMIT + 1])('rejects an out-of-range config limit %s at load', async (limit) => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await expect(ctx.plugin(ToolUltsearch, { limit })).rejects.toThrow(/limit/)
  })
})

describe('execution through the real registry', () => {
  it('executes ultsearch and formats the grouped results', async () => {
    stubFetchByUrl({
      'https://api.searlo.tech/api/v1/search/web?q=hello&num=2': () => jsonResponse({
        results: [{ title: 'A', url: 'https://a.test', snippet: 's' }],
      }),
      'https://api.exa.ai/search': () => jsonResponse({ results: [] }),
    })
    const { fiber, call } = await mountTools({
      config: { searloApiKey: 'sk', exaApiKey: 'ek', limit: 2 },
    })
    const out = await call('ultsearch', { query: 'hello', providers: ['searlo', 'exa'] })
    expect(out.isError).toBe(false)
    expect(out.value).toEqual({
      providers: [
        {
          provider: 'searlo',
          label: 'Searlo',
          results: [{ title: 'A', url: 'https://a.test', snippet: 's' }],
        },
        { provider: 'exa', label: 'Exa', results: [] },
      ],
    })
    const text = out.content.map(block => block.type === 'text' ? block.text : '').join('')
    expect(text).toContain('### searlo (Searlo)')
    expect(text).toContain('[A](https://a.test) — s')
    expect(text).toContain('### exa (Exa)\nNo results found.')
    await fiber.dispose()
  })

  it('reports unconfigured providers as non-fatal per-provider entries', async () => {
    const fetchMock = stubFetchByUrl({
      'https://api.searlo.tech/api/v1/search/web?q=hello&num=8': () => jsonResponse({ results: [] }),
    })
    const { fiber, call } = await mountTools({ config: { searloApiKey: 'sk' } })
    const out = await call('ultsearch', { query: 'hello' })
    expect(out.isError).toBe(false)
    const groups = (out.value as unknown as { providers: ProviderResultGroup[] }).providers
    expect(groups[0]?.error).toBeUndefined()
    expect(groups.slice(1).map(group => group.error)).toEqual([
      'not configured: no EXA_API_KEY',
      'not configured: no TAVILY_API_KEY',
      'not configured: no SERPER_API_KEY',
      'not configured: no SEARXNG_DIR',
    ])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await fiber.dispose()
  })

  it('resolves keys from the launch environment when config omits them', async () => {
    const prev = process.env.SEARLO_API_KEY
    process.env.SEARLO_API_KEY = 'env-searlo'
    try {
      const fetchMock = stubFetchByUrl({
        'https://api.searlo.tech/api/v1/search/web?q=hello&num=8': () => jsonResponse({ results: [] }),
      })
      const { fiber, call } = await mountTools()
      const out = await call('ultsearch', { query: 'hello', providers: ['searlo'] })
      expect(out.isError).toBe(false)
      const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
      expect((init.headers as Record<string, string>)['x-api-key']).toBe('env-searlo')
      await fiber.dispose()
    } finally {
      if (prev === undefined) delete process.env.SEARLO_API_KEY
      else process.env.SEARLO_API_KEY = prev
    }
  })

  it('drives SearXNG through docker compose when configured', async () => {
    execFileMock.mockImplementation((_file, _args, _options, callback) => {
      callback(null, '', '')
      return { on: () => undefined }
    })
    stubFetchByUrl({
      'http://localhost:8080/search?q=hello+world&format=json&safesearch=0': () => jsonResponse({ results: [] }),
    })
    const { fiber, call } = await mountTools({ config: { searxngDir: '/tmp/searxng' } })
    const out = await call('ultsearch', { query: 'hello world', providers: ['searxng'] })
    expect(out.isError).toBe(false)
    expect(execFileMock).toHaveBeenCalledTimes(2)
    await fiber.dispose()
  })

  it('contains one failing provider as its own error entry', async () => {
    stubFetchByUrl({
      'https://api.searlo.tech/api/v1/search/web?q=hello&num=8': () => jsonResponse({ results: [] }),
      'https://api.exa.ai/search': () => Promise.reject(new TypeError('connection refused')),
    })
    const { fiber, call } = await mountTools({ config: { searloApiKey: 'sk', exaApiKey: 'ek' } })
    const out = await call('ultsearch', { query: 'hello', providers: ['searlo', 'exa'] })
    expect(out.isError).toBe(false)
    const groups = (out.value as unknown as { providers: ProviderResultGroup[] }).providers
    expect(groups[1]?.error).toBe('connection refused')
    const text = out.content.map(block => block.type === 'text' ? block.text : '').join('')
    expect(text).toContain('Error: connection refused')
    await fiber.dispose()
  })

  it.each([{}, { query: 123 }, { providers: ['nope'] }])('rejects malformed arguments with INVALID_ARGS', async (args) => {
    const { fiber, call } = await mountTools()
    const out = await call('ultsearch', args)
    expect(out.isError).toBe(true)
    expect(out.error?.info?.code).toBe('INVALID_ARGS')
    await fiber.dispose()
  })

  it('rejects an oversized limit and a blank query with readable value errors', async () => {
    const { fiber, call } = await mountTools()
    const oversized = await call('ultsearch', { query: 'q', limit: MAX_RESULT_LIMIT + 1 })
    expect(oversized.isError).toBe(true)
    expect(oversized.content).toEqual([{ type: 'text', text: `Error: limit must be a positive integer at most ${MAX_RESULT_LIMIT}` }])
    const blank = await call('ultsearch', { query: '  ' })
    expect(blank.isError).toBe(true)
    expect(blank.content).toEqual([{ type: 'text', text: 'Error: query must be a non-empty string' }])
    await fiber.dispose()
  })

  it('exposes the provider ids through the model schema', async () => {
    const { fiber, ctx } = await mountTools()
    const schema = ctx.tools.schemas().find(item => item.name === 'ultsearch')
    const parameters = schema?.parameters as { properties?: Record<string, { items?: { enum?: string[] } }> }
    expect(parameters.properties?.providers?.items?.enum).toEqual([...PROVIDER_IDS])
    expect(PROVIDER_LABELS).toMatchObject({ searlo: 'Searlo', exa: 'Exa', tavily: 'Tavily', serper: 'Serper', searxng: 'SearXNG' })
    await fiber.dispose()
  })
})
