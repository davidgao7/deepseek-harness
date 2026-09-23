/**
 * Ollama client shared by the omni tools: request-body construction, response
 * parsing, and the fetch paths. Vision and text calls go through the native
 * `/api/chat` endpoint; audio calls go through the OpenAI-compatible
 * `/v1/chat/completions` endpoint with an `input_audio` content block, because
 * the native endpoint silently drops `audios` on audio-capable models (Ollama
 * issue #17730). HTTP and parsing stay in small pure functions so tests
 * exercise every branch with a stubbed global `fetch` and no real Ollama
 * server.
 * @module @deepseek-ai/dsh-tool-omni/ollama
 */

/**
 * Typed failure for every Ollama call path. It still extends `Error`, so the
 * tool registry turns it into a model-facing error result exactly like any
 * plain error, while `code` keeps the failure class machine-routable.
 */
export class OllamaError extends Error {
  /** Stable machine-routable failure class (e.g. `OLLAMA_HTTP_ERROR`). */
  readonly code: string

  constructor(message: string, code: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'OllamaError'
    this.code = code
  }
}

/**
 * Render an arbitrary thrown value to its message for error text.
 * @param error - the caught value (`unknown` in catch clauses).
 * @returns the `Error` message, or the string form of any other value.
 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The JSON body sent to Ollama `/api/chat`; `images` carries one base64 payload when present. */
export interface OllamaChatBody {
  model: string
  messages: Array<{ role: 'user'; content: string; images?: string[] }>
  stream: false
  think: false
}

/**
 * Build the `/api/chat` request body for one user turn. `imageB64` is the raw
 * base64 payload Ollama accepts in `images` for vision models; omitting it
 * yields the plain-text form used by the video summary call.
 * @param model - the Ollama model name.
 * @param content - the user prompt.
 * @param imageB64 - optional base64 media payload for the vision path.
 * @returns the chat body with `stream: false` and `think: false`.
 */
export function buildChatBody(model: string, content: string, imageB64?: string): OllamaChatBody {
  const message: { role: 'user'; content: string; images?: string[] } = { role: 'user', content }
  if (imageB64 !== undefined) message.images = [imageB64]
  return { model, messages: [message], stream: false, think: false }
}

/**
 * Reject a non-object response body and an in-band `error` field, then return
 * the response as a record. Shared by the native and OpenAI-compatible
 * response parsers.
 * @param data - the parsed response JSON.
 * @returns the response as a record.
 * @throws {@link OllamaError} `OLLAMA_RESPONSE_INVALID` for a non-object
 *   response or `OLLAMA_ERROR` for an in-band `error` field.
 */
function assertRecordResponse(data: unknown): Record<string, unknown> {
  if (typeof data !== 'object' || data === null) {
    throw new OllamaError('omni: Ollama returned a non-object response', 'OLLAMA_RESPONSE_INVALID')
  }
  const record = data as Record<string, unknown>
  if (typeof record.error === 'string') {
    throw new OllamaError(`omni: Ollama error: ${record.error}`, 'OLLAMA_ERROR')
  }
  return record
}

/**
 * Extract the model's text from an Ollama `/api/chat` JSON response, rejecting
 * the in-band `error` field and absent or empty `message.content`.
 * @param data - the parsed response JSON.
 * @returns the model's content text.
 * @throws {@link OllamaError} for a non-object response, an `error` field, a
 *   missing `message`, or missing/empty `message.content`.
 */
export function parseOllamaContent(data: unknown): string {
  const record = assertRecordResponse(data)
  if (typeof record.message !== 'object' || record.message === null) {
    throw new OllamaError('omni: Ollama response has no message field', 'OLLAMA_RESPONSE_INVALID')
  }
  const content = (record.message as Record<string, unknown>).content
  if (typeof content !== 'string' || content.trim().length === 0) {
    throw new OllamaError('omni: Ollama returned empty content', 'OLLAMA_EMPTY_CONTENT')
  }
  return content
}

/** The JSON body sent to Ollama `/v1/chat/completions` for audio input. */
export interface OllamaOpenAiAudioBody {
  model: string
  messages: Array<{
    role: 'user'
    content: Array<
      | { type: 'input_audio'; input_audio: { data: string; format: 'wav' } }
      | { type: 'text'; text: string }
    >
  }>
}

/**
 * Build the OpenAI-compatible `/v1/chat/completions` body for one audio turn.
 * The audio payload rides an `input_audio` content block followed by the text
 * prompt; the native `/api/chat` endpoint silently drops audio on
 * audio-capable models (Ollama issue #17730), so audio never uses that path.
 * @param model - the Ollama model name.
 * @param content - the user prompt.
 * @param audioB64 - the base64 WAV payload for the `input_audio` block.
 * @returns the chat body with `stream` omitted (defaults to false).
 */
export function buildOpenAiAudioBody(model: string, content: string, audioB64: string): OllamaOpenAiAudioBody {
  return {
    model,
    messages: [{
      role: 'user',
      content: [
        { type: 'input_audio', input_audio: { data: audioB64, format: 'wav' } },
        { type: 'text', text: content },
      ],
    }],
  }
}

/** Whether `data` is a string (the OpenAI-compat `choices[0].message.content`). */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

/**
 * Extract the model's text from an OpenAI-compatible `/v1/chat/completions`
 * JSON response, rejecting the in-band `error` field and absent or empty
 * `choices[0].message.content`.
 * @param data - the parsed response JSON.
 * @returns the model's content text.
 * @throws {@link OllamaError} for a non-object response, an `error` field, a
 *   missing `choices` array, a missing `message`, or missing/empty content.
 */
export function parseOpenAiContent(data: unknown): string {
  const record = assertRecordResponse(data)
  const choices = record.choices
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new OllamaError('omni: Ollama response has no choices field', 'OLLAMA_RESPONSE_INVALID')
  }
  const first = choices[0] as { message?: { content?: unknown } } | null | undefined
  const content = first?.message?.content
  if (!isNonEmptyString(content)) {
    throw new OllamaError('omni: Ollama returned empty content', 'OLLAMA_EMPTY_CONTENT')
  }
  return content
}

/** Shared POST request settings for the two Ollama endpoints. */
interface PostRequest {
  /** Ollama base URL; a trailing slash is tolerated. */
  baseUrl: string
  /** Endpoint path under the base URL, e.g. `/api/chat`. */
  path: string
  /** Serialized JSON request body. */
  body: string
  /** Caller cancellation, forwarded to the fetch. */
  signal: AbortSignal
  /** Hard request timeout in milliseconds; the fetch aborts when it expires. */
  timeoutMs: number
}

/**
 * POST one JSON request to an Ollama endpoint and return the parsed response.
 * The caller signal and an internal timeout are fused into one abort signal so
 * either cancels the in-flight fetch. Caller abort surfaces as `OLLAMA_ABORTED`
 * so the registry can replace it with its canonical cancellation result;
 * transport, HTTP, and invalid-JSON failures surface as {@link OllamaError}.
 * @param request - base URL, endpoint path, JSON body, and cancellation.
 * @returns the parsed response JSON.
 * @throws {@link OllamaError} on abort, transport failure, HTTP error, or
 *   invalid JSON.
 */
async function postOllamaJson(request: PostRequest): Promise<unknown> {
  const base = request.baseUrl.replace(/\/+$/, '')
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(request.timeoutMs)])
  let response: Response
  try {
    response = await fetch(`${base}${request.path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: request.body,
      signal,
    })
  } catch (error) {
    if (request.signal.aborted) {
      throw new OllamaError('omni: request aborted', 'OLLAMA_ABORTED', { cause: error })
    }
    throw new OllamaError(`omni: Ollama request failed: ${errorMessage(error)}`, 'OLLAMA_REQUEST_FAILED', { cause: error })
  }
  if (!response.ok) {
    throw new OllamaError(`omni: Ollama responded with HTTP ${response.status}${response.statusText.length > 0 ? ` ${response.statusText}` : ''}`, 'OLLAMA_HTTP_ERROR')
  }
  try {
    return await response.json()
  } catch (error) {
    throw new OllamaError(`omni: Ollama returned invalid JSON: ${errorMessage(error)}`, 'OLLAMA_RESPONSE_INVALID', { cause: error })
  }
}

/** Options for one {@link ollamaAudio} call. */
export interface OllamaAudioOptions {
  /** Ollama base URL; a trailing slash is tolerated. */
  baseUrl: string
  /** The Ollama model name. */
  model: string
  /** The user prompt text. */
  content: string
  /** Base64 WAV payload sent through the OpenAI-compatible `input_audio` block. */
  audioB64: string
  /** Caller cancellation, forwarded to the fetch. */
  signal: AbortSignal
  /** Hard request timeout in milliseconds; the fetch aborts when it expires. */
  timeoutMs: number
}

/**
 * POST one audio chat request to `${baseUrl}/v1/chat/completions` and return
 * the model's text. The OpenAI-compatible endpoint is required for audio
 * because the native `/api/chat` endpoint silently drops `audios` on
 * audio-capable models (Ollama issue #17730). Failure handling matches
 * {@link ollamaChat}: caller abort surfaces as `OLLAMA_ABORTED`, and HTTP,
 * transport, in-band error, and empty-content failures surface as
 * {@link OllamaError}.
 * @param options - endpoint, model, prompt, audio payload, and cancellation.
 * @returns the model's content text.
 * @throws {@link OllamaError} on abort, transport failure, HTTP error, invalid
 *   JSON, or an unusable response body.
 */
export async function ollamaAudio(options: OllamaAudioOptions): Promise<string> {
  const data = await postOllamaJson({
    baseUrl: options.baseUrl,
    path: '/v1/chat/completions',
    body: JSON.stringify(buildOpenAiAudioBody(options.model, options.content, options.audioB64)),
    signal: options.signal,
    timeoutMs: options.timeoutMs,
  })
  return parseOpenAiContent(data)
}

/** Options for one {@link ollamaChat} call. */
export interface OllamaChatOptions {
  /** Ollama base URL; a trailing slash is tolerated. */
  baseUrl: string
  /** The Ollama model name. */
  model: string
  /** The user prompt text. */
  content: string
  /** Optional base64 media payload for the vision path. */
  imageB64?: string
  /** Caller cancellation, forwarded to the fetch. */
  signal: AbortSignal
  /** Hard request timeout in milliseconds; the fetch aborts when it expires. */
  timeoutMs: number
}

/**
 * POST one chat request to `${baseUrl}/api/chat` and return the model's text.
 * The caller signal and an internal timeout are fused into one abort signal so
 * either cancels the in-flight fetch. HTTP failures, the in-band `error` field,
 * and empty content surface as {@link OllamaError}; a caller abort is reported
 * as `OLLAMA_ABORTED` so the registry can replace it with its canonical
 * cancellation result.
 * @param options - endpoint, model, content, optional image, and cancellation.
 * @returns the model's content text.
 * @throws {@link OllamaError} on abort, transport failure, HTTP error, invalid
 *   JSON, or an unusable response body.
 */
export async function ollamaChat(options: OllamaChatOptions): Promise<string> {
  const data = await postOllamaJson({
    baseUrl: options.baseUrl,
    path: '/api/chat',
    body: JSON.stringify(buildChatBody(options.model, options.content, options.imageB64)),
    signal: options.signal,
    timeoutMs: options.timeoutMs,
  })
  return parseOllamaContent(data)
}
