import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildChatBody,
  buildOpenAiAudioBody,
  errorMessage,
  OllamaError,
  ollamaAudio,
  ollamaChat,
  parseOllamaContent,
  parseOpenAiContent,
} from '../src/ollama.ts'

const never = new AbortController().signal

function okResponse(content: string): Response {
  return new Response(JSON.stringify({ message: { content } }), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

function openAiOkResponse(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('buildChatBody', () => {
  it('builds a plain-text chat body with stream and think disabled', () => {
    const body = buildChatBody('nemotron3:33b', 'hello')
    expect(body).toEqual({ model: 'nemotron3:33b', messages: [{ role: 'user', content: 'hello' }], stream: false, think: false })
  })

  it('attaches one base64 payload as the images entry', () => {
    const body = buildChatBody('m', 'look', 'b64data')
    expect(body.messages[0]?.images).toEqual(['b64data'])
    expect(body.stream).toBe(false)
    expect(body.think).toBe(false)
  })
})

describe('parseOllamaContent', () => {
  it('returns the model content from a well-formed response', () => {
    expect(parseOllamaContent({ message: { content: 'a cat' } })).toBe('a cat')
  })

  it('rejects the in-band error field', () => {
    try {
      parseOllamaContent({ error: 'model not found' })
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(OllamaError)
      expect((error as OllamaError).code).toBe('OLLAMA_ERROR')
      expect((error as OllamaError).message).toContain('model not found')
    }
  })

  it.each([null, 'text', 42])('rejects a non-object response: %s', (data) => {
    expect(() => parseOllamaContent(data)).toThrow(/non-object response/)
  })

  it('rejects a response without a message field', () => {
    expect(() => parseOllamaContent({ other: true })).toThrow(/no message field/)
  })

  it('rejects a non-object message field', () => {
    expect(() => parseOllamaContent({ message: 'nope' })).toThrow(/no message field/)
  })

  it.each([42, '', '   '])('rejects missing or empty content: %j', (content) => {
    expect(() => parseOllamaContent({ message: { content } })).toThrow(/empty content/)
  })
})

describe('errorMessage', () => {
  it('renders Error messages and stringifies other values', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom')
    expect(errorMessage('plain')).toBe('plain')
    expect(errorMessage(42)).toBe('42')
  })
})

describe('OllamaError', () => {
  it('is a plain Error carrying a stable code', () => {
    const error = new OllamaError('x', 'OLLAMA_X', { cause: new Error('cause') })
    expect(error).toBeInstanceOf(Error)
    expect(error.code).toBe('OLLAMA_X')
    expect(error.name).toBe('OllamaError')
    expect(error.cause).toBeInstanceOf(Error)
  })
})

describe('ollamaChat', () => {
  it('posts the chat body to /api/chat and returns the model text', async () => {
    const seen: Array<{ url: string; init: RequestInit }> = []
    vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
      seen.push({ url: input, init: init ?? {} })
      return okResponse('described image')
    }))
    const text = await ollamaChat({ baseUrl: 'http://localhost:11434/', model: 'nemotron3:33b', content: 'what is this', imageB64: 'cGF5bG9hZA==', signal: never, timeoutMs: 1000 })
    expect(text).toBe('described image')
    expect(seen).toHaveLength(1)
    expect(seen[0]?.url).toBe('http://localhost:11434/api/chat')
    expect(seen[0]?.init.method).toBe('POST')
    expect(seen[0]?.init.headers).toEqual({ 'Content-Type': 'application/json' })
    const body = JSON.parse(seen[0]?.init.body as string) as {
      model: string
      messages: Array<{ role: string; content: string; images?: string[] }>
      stream: boolean
      think: boolean
    }
    expect(body.model).toBe('nemotron3:33b')
    expect(body.messages[0]).toEqual({ role: 'user', content: 'what is this', images: ['cGF5bG9hZA=='] })
    expect(body.stream).toBe(false)
    expect(body.think).toBe(false)
  })

  it('reports a non-2xx status with the status text', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('down', { status: 503, statusText: 'Service Unavailable' })))
    const pending = ollamaChat({ baseUrl: 'http://localhost:11434', model: 'm', content: 'c', signal: never, timeoutMs: 1000 })
    await expect(pending).rejects.toThrow(/HTTP 503 Service Unavailable/)
    await expect(pending).rejects.toMatchObject({ code: 'OLLAMA_HTTP_ERROR' })
  })

  it('reports a non-2xx status without a status text', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('down', { status: 500 })))
    await expect(ollamaChat({ baseUrl: 'http://localhost:11434', model: 'm', content: 'c', signal: never, timeoutMs: 1000 }))
      .rejects.toThrow(/HTTP 500/)
  })

  it('surfaces the in-band error field from a 200 response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'model not found' }), { status: 200 })))
    await expect(ollamaChat({ baseUrl: 'http://localhost:11434', model: 'm', content: 'c', signal: never, timeoutMs: 1000 }))
      .rejects.toThrow(/Ollama error: model not found/)
  })

  it('rejects invalid JSON bodies', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not json', { status: 200 })))
    await expect(ollamaChat({ baseUrl: 'http://localhost:11434', model: 'm', content: 'c', signal: never, timeoutMs: 1000 }))
      .rejects.toThrow(/invalid JSON/)
  })

  it('rejects empty model content', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse('')))
    await expect(ollamaChat({ baseUrl: 'http://localhost:11434', model: 'm', content: 'c', signal: never, timeoutMs: 1000 }))
      .rejects.toThrow(/empty content/)
  })

  it('reports transport failures with the underlying cause', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED') }))
    await expect(ollamaChat({ baseUrl: 'http://localhost:11434', model: 'm', content: 'c', signal: never, timeoutMs: 1000 }))
      .rejects.toThrow(/Ollama request failed: ECONNREFUSED/)
  })

  it('reports a caller abort as OLLAMA_ABORTED', async () => {
    const controller = new AbortController()
    controller.abort()
    vi.stubGlobal('fetch', vi.fn((input: string, init?: RequestInit) => {
      if (init?.signal?.aborted === true) return Promise.reject(new DOMException('The operation was aborted.', 'AbortError'))
      return Promise.reject(new Error(`should not reach the network: ${input}`))
    }))
    const pending = ollamaChat({ baseUrl: 'http://localhost:11434', model: 'm', content: 'c', signal: controller.signal, timeoutMs: 1000 })
    await expect(pending).rejects.toThrow(/request aborted/)
    await expect(pending).rejects.toMatchObject({ code: 'OLLAMA_ABORTED' })
  })

  it('times out an unresponsive server into OLLAMA_REQUEST_FAILED', async () => {
    vi.stubGlobal('fetch', vi.fn((_input: string, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => { reject(new Error('fetch aborted by timeout signal')) }, { once: true })
    })))
    const started = Date.now()
    const pending = ollamaChat({ baseUrl: 'http://localhost:11434', model: 'm', content: 'c', signal: never, timeoutMs: 25 })
    await expect(pending).rejects.toThrow(/Ollama request failed/)
    expect(Date.now() - started).toBeGreaterThanOrEqual(20)
  })
})

describe('buildOpenAiAudioBody', () => {
  it('builds an OpenAI-compatible audio body with input_audio and text blocks', () => {
    const body = buildOpenAiAudioBody('gemma4:12b', 'describe this', 'b64wav')
    expect(body.model).toBe('gemma4:12b')
    expect(body.messages).toEqual([{
      role: 'user',
      content: [
        { type: 'input_audio', input_audio: { data: 'b64wav', format: 'wav' } },
        { type: 'text', text: 'describe this' },
      ],
    }])
  })
})

describe('parseOpenAiContent', () => {
  it('returns the model content from a well-formed response', () => {
    expect(parseOpenAiContent({ choices: [{ message: { content: 'spoken words' } }] })).toBe('spoken words')
  })

  it('rejects the in-band error field', () => {
    try {
      parseOpenAiContent({ error: 'model not found' })
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(OllamaError)
      expect((error as OllamaError).code).toBe('OLLAMA_ERROR')
      expect((error as OllamaError).message).toContain('model not found')
    }
  })

  it.each([null, 'text', 42])('rejects a non-object response: %s', (data) => {
    expect(() => parseOpenAiContent(data)).toThrow(/non-object response/)
  })

  it('rejects a response without a choices field', () => {
    expect(() => parseOpenAiContent({ other: true })).toThrow(/no choices field/)
  })

  it('rejects an empty choices array', () => {
    expect(() => parseOpenAiContent({ choices: [] })).toThrow(/no choices field/)
  })

  it.each([42, '', '   '])('rejects missing or empty content: %j', (content) => {
    expect(() => parseOpenAiContent({ choices: [{ message: { content } }] })).toThrow(/empty content/)
  })
})

describe('ollamaAudio', () => {
  it('posts the OpenAI-compatible audio body to /v1/chat/completions and returns the model text', async () => {
    const seen: Array<{ url: string; init: RequestInit }> = []
    vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
      seen.push({ url: input, init: init ?? {} })
      return openAiOkResponse('described audio')
    }))
    const text = await ollamaAudio({ baseUrl: 'http://localhost:11434/', model: 'gemma4:12b', content: 'describe this', audioB64: 'b64wav', signal: never, timeoutMs: 1000 })
    expect(text).toBe('described audio')
    expect(seen).toHaveLength(1)
    expect(seen[0]?.url).toBe('http://localhost:11434/v1/chat/completions')
    expect(seen[0]?.init.method).toBe('POST')
    const body = JSON.parse(seen[0]?.init.body as string) as { model: string; messages: unknown[] }
    expect(body.model).toBe('gemma4:12b')
    expect(body.messages).toEqual([{
      role: 'user',
      content: [
        { type: 'input_audio', input_audio: { data: 'b64wav', format: 'wav' } },
        { type: 'text', text: 'describe this' },
      ],
    }])
  })

  it('reports a non-2xx status with the status text', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('down', { status: 503, statusText: 'Service Unavailable' })))
    const pending = ollamaAudio({ baseUrl: 'http://localhost:11434', model: 'm', content: 'c', audioB64: 'x', signal: never, timeoutMs: 1000 })
    await expect(pending).rejects.toThrow(/HTTP 503 Service Unavailable/)
    await expect(pending).rejects.toMatchObject({ code: 'OLLAMA_HTTP_ERROR' })
  })

  it('reports a non-2xx status without a status text', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('down', { status: 500 })))
    await expect(ollamaAudio({ baseUrl: 'http://localhost:11434', model: 'm', content: 'c', audioB64: 'x', signal: never, timeoutMs: 1000 }))
      .rejects.toThrow(/HTTP 500/)
  })

  it('surfaces the in-band error field from a 200 response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'audio unsupported' }), { status: 200 })))
    await expect(ollamaAudio({ baseUrl: 'http://localhost:11434', model: 'm', content: 'c', audioB64: 'x', signal: never, timeoutMs: 1000 }))
      .rejects.toThrow(/Ollama error: audio unsupported/)
  })

  it('rejects invalid JSON bodies', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not json', { status: 200 })))
    await expect(ollamaAudio({ baseUrl: 'http://localhost:11434', model: 'm', content: 'c', audioB64: 'x', signal: never, timeoutMs: 1000 }))
      .rejects.toThrow(/invalid JSON/)
  })

  it('rejects empty model content', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => openAiOkResponse('')))
    await expect(ollamaAudio({ baseUrl: 'http://localhost:11434', model: 'm', content: 'c', audioB64: 'x', signal: never, timeoutMs: 1000 }))
      .rejects.toThrow(/empty content/)
  })

  it('reports transport failures with the underlying cause', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED') }))
    await expect(ollamaAudio({ baseUrl: 'http://localhost:11434', model: 'm', content: 'c', audioB64: 'x', signal: never, timeoutMs: 1000 }))
      .rejects.toThrow(/Ollama request failed: ECONNREFUSED/)
  })

  it('reports a caller abort as OLLAMA_ABORTED', async () => {
    const controller = new AbortController()
    controller.abort()
    vi.stubGlobal('fetch', vi.fn((input: string, init?: RequestInit) => {
      if (init?.signal?.aborted === true) return Promise.reject(new DOMException('The operation was aborted.', 'AbortError'))
      return Promise.reject(new Error(`should not reach the network: ${input}`))
    }))
    const pending = ollamaAudio({ baseUrl: 'http://localhost:11434', model: 'm', content: 'c', audioB64: 'x', signal: controller.signal, timeoutMs: 1000 })
    await expect(pending).rejects.toThrow(/request aborted/)
    await expect(pending).rejects.toMatchObject({ code: 'OLLAMA_ABORTED' })
  })

  it('times out an unresponsive server into OLLAMA_REQUEST_FAILED', async () => {
    vi.stubGlobal('fetch', vi.fn((_input: string, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => { reject(new Error('fetch aborted by timeout signal')) }, { once: true })
    })))
    const started = Date.now()
    const pending = ollamaAudio({ baseUrl: 'http://localhost:11434', model: 'm', content: 'c', audioB64: 'x', signal: never, timeoutMs: 25 })
    await expect(pending).rejects.toThrow(/Ollama request failed/)
    expect(Date.now() - started).toBeGreaterThanOrEqual(20)
  })
})
