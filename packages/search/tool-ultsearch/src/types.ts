/**
 * Wire response shapes of the search APIs queried by `ultsearch`. These types
 * document each provider's response contract; the mapping code in
 * `ultsearch.ts` stays defensive because JSON boundaries are untrusted, so
 * every field is optional.
 * @module @deepseek-ai/dsh-tool-ultsearch/types
 */

/** One Searlo result item (Google SERP style; `description` mirrors `snippet`). */
export interface SearloItem {
  title?: string
  url?: string
  snippet?: string
  description?: string
}

/** Searlo `GET /api/v1/search/web` response. */
export interface SearloResponse {
  results?: SearloItem[]
  organic?: SearloItem[]
}

/** One Exa `POST /search` result item. */
export interface ExaItem {
  title?: string
  url?: string
  /** Body text when `contents.text` is requested. */
  text?: string
  /** Highlight sentences; the first non-blank one becomes the snippet. */
  highlights?: string[]
}

/** Exa `POST /search` response. */
export interface ExaResponse {
  results?: ExaItem[]
}

/** One Tavily `POST /search` result item. */
export interface TavilyItem {
  title?: string
  url?: string
  content?: string
}

/** Tavily `POST /search` response. */
export interface TavilyResponse {
  results?: TavilyItem[]
}

/** One Serper `POST /search` result item; Serper names the URL `link`. */
export interface SerperItem {
  title?: string
  link?: string
  snippet?: string
}

/** Serper `POST /search` response (Google SERP style). */
export interface SerperResponse {
  organic?: SerperItem[]
}

/** One SearXNG JSON result item. */
export interface SearxngItem {
  title?: string
  url?: string
  content?: string
}

/** SearXNG `format=json` response. */
export interface SearxngResponse {
  results?: SearxngItem[]
}
