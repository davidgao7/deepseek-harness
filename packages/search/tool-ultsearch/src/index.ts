/**
 * Model-facing `ultsearch` tool: parallel queries across several independent
 * web-search providers, with results grouped and labeled per provider. This
 * package owns the provider clients directly — it does NOT go through the
 * `ctx.web` seam, which enforces single-provider selection.
 * @module @deepseek-ai/dsh-tool-ultsearch
 */

import type { Context } from '@deepseek-ai/cordis'
import type { LaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  DEFAULT_RESULT_LIMIT,
  MAX_RESULT_LIMIT,
  PROVIDER_IDS,
  SEARXNG_DEFAULT_BASE_URL,
  formatGroupedOutput,
  parseArgs,
  runUltsearch,
  type ProviderId,
  type ResolvedProviderKeys,
} from './ultsearch.ts'

export {
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
  type ProviderId,
  type ProviderResultGroup,
  type ResolvedProviderKeys,
  type ResolvedUltsearchArgs,
  type RunUltsearchOptions,
  type SearchResultEntry,
  type UltsearchArgs,
} from './ultsearch.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-ultsearch'

/** Services required by the ultsearch tool. */
export const inject = ['tools', 'systemPrompt']

/** Plugin config: per-provider API keys, the result bound, and SearXNG settings. */
export interface Config {
  /** Upper bound on results per provider in one call. Defaults to 8. */
  limit?: number
  /** Searlo API key. Falls back to `$SEARLO_API_KEY`. Empty → provider not configured. */
  searloApiKey?: string
  /** Exa API key. Falls back to `$EXA_API_KEY` then `$EXA_API`. */
  exaApiKey?: string
  /** Tavily API key. Falls back to `$TAVILY_API_KEY`. */
  tavilyApiKey?: string
  /** Serper API key. Falls back to `$SERPER_API_KEY`. */
  serperApiKey?: string
  /** Directory holding the SearXNG docker-compose project. Falls back to `$SEARXNG_DIR`. */
  searxngDir?: string
  /** SearXNG instance base URL. Defaults to `http://localhost:8080`. */
  searxngBaseUrl?: string
}

export const Config: z<Config> = z.object({
  limit: z.number().step(1).min(1).max(MAX_RESULT_LIMIT).default(DEFAULT_RESULT_LIMIT),
  searloApiKey: z.string(),
  exaApiKey: z.string(),
  tavilyApiKey: z.string(),
  serperApiKey: z.string(),
  searxngDir: z.string(),
  searxngBaseUrl: z.string().default(SEARXNG_DEFAULT_BASE_URL),
})

/** Complete config after schemastery applies every field default. */
type ResolvedConfig = {
  limit: number
  searloApiKey?: string
  exaApiKey?: string
  tavilyApiKey?: string
  serperApiKey?: string
  searxngDir?: string
  searxngBaseUrl: string
}

/** Provider ids that authenticate with an API key. */
const KEYED_PROVIDER_IDS = ['searlo', 'exa', 'tavily', 'serper'] as const satisfies readonly ProviderId[]

type KeyedProviderId = typeof KEYED_PROVIDER_IDS[number]

/** Config fields that can hold a provider API key. */
type KeyedConfigField = 'searloApiKey' | 'exaApiKey' | 'tavilyApiKey' | 'serperApiKey'

/** Config field that supplies each keyed provider's key. */
const PROVIDER_KEY_CONFIG: Record<KeyedProviderId, KeyedConfigField> = {
  searlo: 'searloApiKey',
  exa: 'exaApiKey',
  tavily: 'tavilyApiKey',
  serper: 'serperApiKey',
}

/** Environment variable names that supply each keyed provider's key, in trust order. */
const PROVIDER_KEY_ENV: Record<KeyedProviderId, readonly string[]> = {
  searlo: ['SEARLO_API_KEY'],
  exa: ['EXA_API_KEY', 'EXA_API'],
  tavily: ['TAVILY_API_KEY'],
  serper: ['SERPER_API_KEY'],
}

/**
 * Resolve each keyed provider's API key: the plugin config field wins, then
 * the launch environment's variable names in order. Values are trimmed; an
 * absent or blank resolution leaves the provider unconfigured.
 * @param config - the resolved plugin config.
 * @param env - the launch environment snapshot.
 * @returns the non-empty keys found.
 */
export function resolveProviderKeys(config: ResolvedConfig, env: LaunchEnvironmentSnapshot): ResolvedProviderKeys {
  const keys: ResolvedProviderKeys = {}
  for (const id of KEYED_PROVIDER_IDS) {
    const configured = config[PROVIDER_KEY_CONFIG[id]]?.trim()
    if (configured !== undefined && configured.length > 0) {
      keys[id] = configured
      continue
    }
    for (const variable of PROVIDER_KEY_ENV[id]) {
      const value = env.get(variable)?.value.trim()
      if (value !== undefined && value.length > 0) {
        keys[id] = value
        break
      }
    }
  }
  return keys
}

/**
 * Resolve the SearXNG docker-compose directory: plugin config wins, then
 * `$SEARXNG_DIR`. Values are trimmed; an absent or blank resolution leaves
 * the provider unconfigured.
 * @param config - the resolved plugin config.
 * @param env - the launch environment snapshot.
 * @returns the directory, or `undefined` when neither layer supplies one.
 */
export function resolveSearxngDir(config: ResolvedConfig, env: LaunchEnvironmentSnapshot): string | undefined {
  const configured = config.searxngDir?.trim()
  if (configured !== undefined && configured.length > 0) return configured
  const value = env.get('SEARXNG_DIR')?.value.trim()
  if (value !== undefined && value.length > 0) return value
  return undefined
}

/**
 * Register the `ultsearch` tool and its system-prompt guidance.
 * @param ctx - context whose `tools` and `systemPrompt` registries receive the
 *   registrations; both are effect-scoped and unregister on plugin dispose.
 * @param config - the plugin config (schemastery has filled every default).
 */
export function apply(ctx: Context, config: Config): void {
  // schemastery (Config) has already filled every defaulted field.
  const resolved = config as ResolvedConfig
  const env = launchEnvironmentOf(ctx)
  const keys = resolveProviderKeys(resolved, env)
  const searxngDir = resolveSearxngDir(resolved, env)
  ctx.systemPrompt.section({
    name: 'tool:ultsearch',
    order: 109,
    text: `Use the ultsearch tool as your PRIMARY web-search tool for discovering current information. It queries multiple independent web-search providers in parallel and returns results grouped per provider. Pass one non-empty query; optionally set limit (1–${MAX_RESULT_LIMIT}) to bound results per provider and providers to restrict which providers answer. Results are grouped per provider — treat each provider's results independently and cite the relevant URLs as markdown links. Prefer ultsearch over web_search: use it first for any search task.`,
  })
  ctx.tools.register(defineTool({
    name: 'ultsearch',
    description: 'Query multiple independent web-search providers in parallel and return each provider\'s results grouped and labeled separately.',
    parameters: {
      query: { type: 'string', required: true, description: 'The search query.' },
      limit: { type: 'integer', description: `Upper bound on results returned per provider (1–${MAX_RESULT_LIMIT}); defaults to ${DEFAULT_RESULT_LIMIT}.` },
      providers: {
        type: 'array',
        items: { type: 'string', enum: PROVIDER_IDS },
        description: 'Restrict the query to these providers; defaults to every configured provider.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          providers: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                provider: { type: 'string', required: true },
                label: { type: 'string', required: true },
                results: {
                  type: 'array',
                  required: true,
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      title: { type: 'string' },
                      url: { type: 'string', required: true },
                      snippet: { type: 'string' },
                    },
                  },
                },
                error: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: formatGroupedOutput(value.providers) }],
    },
    // Provider reads do not mutate parent-agent state.
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const parsed = parseArgs(args, resolved.limit)
      const groups = await runUltsearch({
        query: parsed.query,
        limit: parsed.limit,
        providers: parsed.providers,
        keys,
        ...(searxngDir !== undefined ? { searxngDir } : {}),
        searxngBaseUrl: resolved.searxngBaseUrl,
        signal: exec.signal,
      })
      return { providers: groups }
    },
  }))
}
