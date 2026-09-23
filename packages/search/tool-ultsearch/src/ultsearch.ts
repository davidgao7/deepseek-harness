/**
 * The model-facing `ultsearch` tool body: argument validation, per-provider
 * HTTP clients, credential sanitization, grouped formatting, and the parallel
 * fan-out. The tool queries several independent web-search providers in
 * PARALLEL and returns results GROUPED per provider — never merged — so the
 * model always knows which provider returned which results. Each provider owns
 * a small `fetch` client; `Promise.allSettled` containment means one failing
 * provider never breaks the others.
 * @module @deepseek-ai/dsh-tool-ultsearch/ultsearch
 */

import { execFile } from 'node:child_process'
import type {
  ExaResponse,
  SearloResponse,
  SearxngResponse,
  SerperResponse,
  TavilyResponse,
} from './types.ts'

/** Provider ids understood by `ultsearch`. */
export type ProviderId = 'searlo' | 'exa' | 'tavily' | 'serper' | 'searxng'

/** All provider ids, in stable display order. */
export const PROVIDER_IDS: readonly ProviderId[] = ['searlo', 'exa', 'tavily', 'serper', 'searxng']

/** Human display names keyed by provider id. */
export const PROVIDER_LABELS: Record<ProviderId, string> = {
  searlo: 'Searlo',
  exa: 'Exa',
  tavily: 'Tavily',
  serper: 'Serper',
  searxng: 'SearXNG',
}

/** Hard cap on results per provider in one call; the config and the model argument share it. */
export const MAX_RESULT_LIMIT = 8

/** Default per-provider result count when a call omits `limit`. */
export const DEFAULT_RESULT_LIMIT = 8

/** Default SearXNG instance base URL. */
export const SEARXNG_DEFAULT_BASE_URL = 'http://localhost:8080'

/** Model-facing `ultsearch` arguments (schema-validated before `parseArgs`). */
export interface UltsearchArgs {
  query: string
  limit?: number
  providers?: string[]
}

/** `parseArgs` output: value-validated arguments with defaults applied. */
export interface ResolvedUltsearchArgs {
  query: string
  limit: number
  providers: readonly ProviderId[]
}

/** One normalized result entry, matching the model-facing output schema. */
export interface SearchResultEntry {
  title?: string
  url: string
  snippet?: string
}

/** One provider's entry in the grouped output: results or a non-fatal error. */
export interface ProviderResultGroup {
  provider: string
  label: string
  results: SearchResultEntry[]
  error?: string
}

/** Resolved API keys for the four keyed providers; absent means not configured. */
export interface ResolvedProviderKeys {
  searlo?: string
  exa?: string
  tavily?: string
  serper?: string
}

/** Input to {@link runUltsearch}. */
export interface RunUltsearchOptions {
  query: string
  limit: number
  providers: readonly ProviderId[]
  keys: ResolvedProviderKeys
  searxngDir?: string
  searxngBaseUrl: string
  signal: AbortSignal
}

/** Per-provider client input: everything {@link runUltsearch} receives except the id list. */
type ProviderOptions = Omit<RunUltsearchOptions, 'providers'>

// ---- credential sanitization ----

/** Query-parameter value redaction: any `?name=value` pair whose name contains a key/token marker. */
const QUERY_PARAM_PATTERN = /([?&][^=&#]*(?:api[_-]?key|apikey|key|token|authorization)[^=&#]*)=[^&#\s]*/gi
/** Header value redaction for `Authorization`/`X-API-KEY`, quoted or bare. */
const HEADER_VALUE_PATTERN = /((?:authorization|x-api-key)["']?[=:]["']?[ \t]*)[^"'\r\n,;]+/gi
/** Bearer token redaction. */
const BEARER_PATTERN = /(bearer[ \t]+)[^\s,;]+/gi

/**
 * Redact credential material from provider or transport error text before it
 * reaches the model: query-parameter values whose name contains a key/token
 * marker, `Authorization`/`X-API-KEY` header values, and Bearer tokens. Every
 * value is replaced with `[redacted]`; ordinary error text passes through
 * unchanged.
 * @param message - raw provider or transport error text.
 * @returns the message with credential values replaced by `[redacted]`.
 */
export function sanitizeError(message: string): string {
  return message
    .replace(QUERY_PARAM_PATTERN, '$1=[redacted]')
    .replace(HEADER_VALUE_PATTERN, '$1[redacted]')
    .replace(BEARER_PATTERN, '$1[redacted]')
}

// ---- argument validation ----

/**
 * Validate value constraints the JSON schema cannot express: `query` is a
 * non-blank string, `limit` is a positive integer within {@link MAX_RESULT_LIMIT},
 * and every requested provider id is known. Exact duplicate provider ids are
 * collapsed after validation. Throws a plain `Error` otherwise.
 * @param args - the schema-validated `ultsearch` arguments.
 * @param defaultLimit - the deployment's per-provider result cap (config `limit`).
 * @returns the accepted query, resolved limit, and provider id list.
 */
export function parseArgs(args: UltsearchArgs, defaultLimit: number): ResolvedUltsearchArgs {
  if (typeof args.query !== 'string' || args.query.trim().length === 0) {
    throw new Error('query must be a non-empty string')
  }
  const limit = args.limit ?? defaultLimit
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_RESULT_LIMIT) {
    throw new Error(`limit must be a positive integer at most ${MAX_RESULT_LIMIT}`)
  }
  let providers: ProviderId[]
  if (args.providers === undefined) {
    providers = [...PROVIDER_IDS]
  } else {
    if (args.providers.length === 0) {
      throw new Error('providers must contain at least one provider')
    }
    providers = [...new Set(args.providers.map((id) => {
      if (!(PROVIDER_IDS as readonly string[]).includes(id)) {
        throw new Error(`unknown provider "${id}" (known: ${PROVIDER_IDS.join(', ')})`)
      }
      return id as ProviderId
    }))]
  }
  return { query: args.query, limit, providers }
}

// ---- formatting ----

/** Display label for a result: its title, else its URL's hostname. */
function resultLabel(result: SearchResultEntry): string {
  if (result.title !== undefined && result.title.length > 0) return result.title
  try {
    return new URL(result.url).hostname
  } catch {
    // A provider should return a valid URL, but never let a malformed one
    // throw out of pure formatting — fall back to the raw string.
    return result.url
  }
}

/**
 * Format the grouped provider results as the model-facing text block.
 * @param groups - one entry per queried provider, in query order.
 * @returns a markdown rendering: one `###` section per provider with its
 *   result lines, its error line or `No results found.`, and a standing
 *   cite-your-sources instruction.
 */
export function formatGroupedOutput(groups: readonly ProviderResultGroup[]): string {
  const parts: string[] = []
  for (const group of groups) {
    const lines: string[] = []
    if (group.error !== undefined) {
      lines.push(`Error: ${group.error}`)
    } else if (group.results.length === 0) {
      lines.push('No results found.')
    } else {
      for (const result of group.results) {
        const label = resultLabel(result)
        const suffix = result.snippet !== undefined && result.snippet.length > 0 ? ` — ${result.snippet}` : ''
        lines.push(`- [${label}](${result.url})${suffix}`)
      }
    }
    parts.push(`### ${group.provider} (${group.label})\n${lines.join('\n')}`)
  }
  parts.push('Cite the relevant URLs above as markdown links in your answer.')
  return parts.join('\n\n')
}

// ---- response normalization ----

/** First non-empty string among the given values. */
function firstNonEmpty(...values: readonly unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) return value
  }
  return undefined
}

/** Build a normalized entry from a record's URL, title, and snippet values. */
function entryFromRecord(
  record: Record<string, unknown>,
  urlField: string,
  ...snippetValues: readonly unknown[]
): SearchResultEntry | undefined {
  const url = record[urlField]
  if (typeof url !== 'string' || url.length === 0) return undefined
  const title = firstNonEmpty(record.title)
  const snippet = firstNonEmpty(...snippetValues)
  return {
    url,
    ...title !== undefined ? { title } : {},
    ...snippet !== undefined ? { snippet } : {},
  }
}

/** Map one raw item record through {@link entryFromRecord}, guarding the item type. */
function mapCommonItem(
  item: unknown,
  urlField: string,
  snippetFields: readonly string[],
): SearchResultEntry | undefined {
  if (typeof item !== 'object' || item === null) return undefined
  const record = item as Record<string, unknown>
  return entryFromRecord(record, urlField, ...snippetFields.map(field => record[field]))
}

/** Map one Exa item; its snippet comes from `text` or the first highlight. */
function mapExaItem(item: unknown): SearchResultEntry | undefined {
  if (typeof item !== 'object' || item === null) return undefined
  const record = item as Record<string, unknown>
  const highlights = record.highlights
  return entryFromRecord(record, 'url', record.text, Array.isArray(highlights) ? highlights[0] : undefined)
}

/** Extract `field`'s array from a payload and map each entry, dropping unusable ones. */
function normalizeEntryList(
  payload: unknown,
  field: string,
  mapItem: (item: unknown) => SearchResultEntry | undefined,
): SearchResultEntry[] {
  if (typeof payload !== 'object' || payload === null) return []
  const raw = (payload as Record<string, unknown>)[field]
  if (!Array.isArray(raw)) return []
  const entries: SearchResultEntry[] = []
  for (const item of raw) {
    const entry = mapItem(item)
    if (entry !== undefined) entries.push(entry)
  }
  return entries
}

function mapSearlo(payload: SearloResponse): SearchResultEntry[] {
  const fromResults = normalizeEntryList(payload, 'results', item => mapCommonItem(item, 'url', ['snippet', 'description']))
  if (fromResults.length > 0) return fromResults
  return normalizeEntryList(payload, 'organic', item => mapCommonItem(item, 'url', ['snippet', 'description']))
}

function mapExa(payload: ExaResponse): SearchResultEntry[] {
  return normalizeEntryList(payload, 'results', mapExaItem)
}

function mapTavily(payload: TavilyResponse): SearchResultEntry[] {
  return normalizeEntryList(payload, 'results', item => mapCommonItem(item, 'url', ['content', 'snippet']))
}

function mapSerper(payload: SerperResponse): SearchResultEntry[] {
  return normalizeEntryList(payload, 'organic', item => mapCommonItem(item, 'link', ['snippet']))
}

function mapSearxng(payload: SearxngResponse): SearchResultEntry[] {
  return normalizeEntryList(payload, 'results', item => mapCommonItem(item, 'url', ['content']))
}

// ---- provider HTTP clients ----

/** Build one provider group with its display label. */
function group(id: ProviderId, results: SearchResultEntry[], error?: string): ProviderResultGroup {
  return {
    provider: id,
    label: PROVIDER_LABELS[id],
    results,
    ...error !== undefined ? { error } : {},
  }
}

/**
 * Extract a provider-readable error detail from an HTTP error body.
 * @param body - the raw error response body text.
 * @returns the first non-empty `error`/`message`/`detail` string field, or
 *   `undefined` for a non-JSON or detail-less body.
 */
function errorDetailFromBody(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as unknown
    if (typeof parsed === 'object' && parsed !== null) {
      const record = parsed as Record<string, unknown>
      const detail = firstNonEmpty(record.error, record.message, record.detail)
      if (detail !== undefined) return detail
    }
  } catch {
    // A non-JSON error body (gateway 5xx/429 pages) has no portable detail.
  }
  return undefined
}

/**
 * Read a provider response as JSON, or throw a descriptive per-provider error.
 * @param response - the settled `fetch` response.
 * @param label - the provider's display name used in the error text.
 * @returns the parsed JSON body on 2xx.
 */
async function parseProviderResponse(response: Response, label: string): Promise<unknown> {
  if (response.ok) return response.json()
  const body = await response.text().catch(() => {
    // An unreadable error body (including an abort mid-read) only costs a
    // richer message; the HTTP status line remains.
    return ''
  })
  const detail = errorDetailFromBody(body)
  throw new Error(detail !== undefined
    ? `${label} search failed: ${detail}`
    : `${label} search failed (HTTP ${response.status})`)
}

async function searchSearlo(options: ProviderOptions): Promise<ProviderResultGroup> {
  const apiKey = options.keys.searlo
  if (!apiKey) return group('searlo', [], 'not configured: no SEARLO_API_KEY')
  const url = new URL('https://api.searlo.tech/api/v1/search/web')
  url.searchParams.set('q', options.query)
  url.searchParams.set('num', String(options.limit))
  const response = await fetch(url, {
    method: 'GET',
    redirect: 'error',
    signal: options.signal,
    headers: { 'x-api-key': apiKey, accept: 'application/json' },
  })
  return group('searlo', mapSearlo(await parseProviderResponse(response, 'Searlo') as SearloResponse))
}

async function searchExa(options: ProviderOptions): Promise<ProviderResultGroup> {
  const apiKey = options.keys.exa
  if (!apiKey) return group('exa', [], 'not configured: no EXA_API_KEY')
  const response = await fetch('https://api.exa.ai/search', {
    method: 'POST',
    redirect: 'error',
    signal: options.signal,
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({
      query: options.query,
      numResults: options.limit,
      contents: { text: { maxCharacters: 300 } },
    }),
  })
  return group('exa', mapExa(await parseProviderResponse(response, 'Exa') as ExaResponse))
}

async function searchTavily(options: ProviderOptions): Promise<ProviderResultGroup> {
  const apiKey = options.keys.tavily
  if (!apiKey) return group('tavily', [], 'not configured: no TAVILY_API_KEY')
  const response = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    redirect: 'error',
    signal: options.signal,
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      api_key: apiKey,
      query: options.query,
      max_results: options.limit,
      search_depth: 'basic',
    }),
  })
  return group('tavily', mapTavily(await parseProviderResponse(response, 'Tavily') as TavilyResponse))
}

async function searchSerper(options: ProviderOptions): Promise<ProviderResultGroup> {
  const apiKey = options.keys.serper
  if (!apiKey) return group('serper', [], 'not configured: no SERPER_API_KEY')
  const response = await fetch('https://google.serper.dev/search', {
    method: 'POST',
    redirect: 'error',
    signal: options.signal,
    headers: {
      'X-API-KEY': apiKey,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({ q: options.query, num: options.limit }),
  })
  return group('serper', mapSerper(await parseProviderResponse(response, 'Serper') as SerperResponse))
}

/** Run one `docker compose` command inside the SearXNG project directory. */
function runCompose(args: readonly string[], dir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('docker', ['compose', ...args], { cwd: dir }, (error) => {
      if (error !== null) reject(new Error(error.message))
      else resolve()
    })
  })
}

async function searchSearxng(options: ProviderOptions): Promise<ProviderResultGroup> {
  const dir = options.searxngDir
  if (!dir) return group('searxng', [], 'not configured: no SEARXNG_DIR')
  let upError: unknown
  try {
    await runCompose(['up', '-d'], dir)
  } catch (error) {
    upError = error
  }
  try {
    if (upError !== undefined) {
      return group('searxng', [], `SearXNG unavailable: docker compose up failed: ${errorText(upError)}`)
    }
    const url = new URL(options.searxngBaseUrl)
    url.pathname = '/search'
    url.searchParams.set('q', options.query)
    url.searchParams.set('format', 'json')
    url.searchParams.set('safesearch', '0')
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'error',
      signal: options.signal,
      headers: { accept: 'application/json' },
    })
    return group('searxng', mapSearxng(await parseProviderResponse(response, 'SearXNG') as SearxngResponse))
  } finally {
    await runCompose(['down'], dir).catch(() => {
      // A failed teardown must not fail or mask the search outcome.
    })
  }
}

// ---- parallel fan-out ----

/** Dispatch one provider id to its HTTP client. */
const PROVIDER_SEARCHERS = {
  searlo: searchSearlo,
  exa: searchExa,
  tavily: searchTavily,
  serper: searchSerper,
  searxng: searchSearxng,
} satisfies Record<ProviderId, (options: ProviderOptions) => Promise<ProviderResultGroup>>

/**
 * Human-readable text of an arbitrary thrown value.
 * @param reason - the thrown value from a rejected provider call.
 * @returns the Error message when `reason` is an Error, otherwise its string form.
 */
export function errorText(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

/**
 * Query every requested provider in parallel and group the outcomes. A
 * provider without a key reports itself as `not configured`; every other
 * failure is contained by `Promise.allSettled` and reported as its own labeled
 * entry with sanitized error text — one failing provider never breaks the
 * others.
 * @param options - query, per-provider limit, keys, SearXNG settings, provider
 *   restriction, and the cancellation signal forwarded to every fetch.
 * @returns one entry per provider, in the requested order.
 */
export async function runUltsearch(options: RunUltsearchOptions): Promise<ProviderResultGroup[]> {
  const settled = await Promise.allSettled(options.providers.map(id => PROVIDER_SEARCHERS[id](options)))
  return settled.map((outcome, index) => {
    // allSettled preserves input order, so the index always falls inside the list.
    const id = options.providers[index] as ProviderId
    if (outcome.status === 'fulfilled') return outcome.value
    return group(id, [], sanitizeError(errorText(outcome.reason)))
  })
}
