import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import * as ToolOmni from '@deepseek-ai/dsh-tool-omni'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as media from '../src/media.ts'
import { buildVideoSummaryPrompt } from '../src/index.ts'

// The ffmpeg/ffprobe layer is injectable: the tools orchestrate it through
// media.ts, so the registry tests stub only the two subprocess-driving helpers
// and keep the temp-dir lifecycle real. No real ffmpeg is needed.
vi.mock('../src/media.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/media.ts')>()
  return {
    ...actual,
    audioToWav: vi.fn(),
    sampleVideoFrames: vi.fn(),
  }
})

const testToolSignal = new AbortController().signal

/** A tiny PNG header; the tools never parse the bytes, they only base64 them. */
const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
  0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4,
  0x89, 0x00, 0x00, 0x00, 0x0A, 0x49, 0x44, 0x41,
  0x54, 0x78, 0x9C, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00,
  0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE,
  0x42, 0x60, 0x82,
])

interface SeenCall {
  url: string
  body: ToolOmni.OllamaChatBody
}

/** Stub global fetch and record every chat request for later assertions. */
function stubOllama(handler: (call: SeenCall) => Response | Promise<Response>): SeenCall[] {
  const seen: SeenCall[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const call = { url: input, body: JSON.parse(init?.body as string) as ToolOmni.OllamaChatBody }
    seen.push(call)
    return await handler(call)
  }))
  return seen
}

function okResponse(content: string): Response {
  return new Response(JSON.stringify({ message: { content } }), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

async function fixtureDir(prefix = 'dsh-omni-tool-'): Promise<string> {
  return await mkdtemp(join(tmpdir(), prefix))
}

async function mountTools(config: ToolOmni.Config = {}): Promise<{
  ctx: Context
  fiber: Awaited<ReturnType<Context['plugin']>>
  call: (name: string, args: unknown) => Promise<ToolExecutionResult>
}> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const fiber = await ctx.plugin(ToolOmni, config)
  let counter = 0
  const call = (name: string, args: unknown) => ctx.tools.execute({ signal: testToolSignal, callId: ToolCallId(`call-${++counter}`), name, arguments: args })
  return { ctx, fiber, call }
}

afterEach(async () => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  delete process.env.OLLAMA_URL
  delete process.env.OMNI_MODEL
})

describe('tool-omni registration', () => {
  it('registers all three tools by default with parallel scheduling, and disposes them', async () => {
    const { ctx, fiber } = await mountTools()
    const names = ctx.tools.schemas().map(schema => schema.name)
    expect(names).toContain('omni_image')
    expect(names).toContain('omni_audio')
    expect(names).toContain('omni_video')
    for (const toolName of ['omni_image', 'omni_audio', 'omni_video']) {
      expect(ctx.tools.executionMode({ signal: testToolSignal, callId: ToolCallId(`${toolName}-mode`), name: toolName, arguments: { path: '/tmp/x' } }))
        .toEqual({ kind: 'parallel' })
    }
    await fiber.dispose()
    expect(ctx.tools.schemas().map(schema => schema.name)).not.toContain('omni_image')
    expect(ctx.tools.schemas().map(schema => schema.name)).not.toContain('omni_audio')
    expect(ctx.tools.schemas().map(schema => schema.name)).not.toContain('omni_video')
  })

  it('registers only the enabled tools', async () => {
    const { ctx, fiber } = await mountTools({ image: true, audio: false, video: false })
    const names = ctx.tools.schemas().map(schema => schema.name)
    expect(names).toContain('omni_image')
    expect(names).not.toContain('omni_audio')
    expect(names).not.toContain('omni_video')
    await fiber.dispose()
  })

  it('registers no tools when every flag is disabled', async () => {
    const { ctx, fiber } = await mountTools({ image: false, audio: false, video: false })
    expect(ctx.tools.schemas().map(schema => schema.name)).toEqual([])
    await fiber.dispose()
  })

  it('has no default export (namespace plugin export shape)', () => {
    expect('default' in ToolOmni).toBe(false)
  })

  it.each([
    ['httpTimeoutMs zero', { httpTimeoutMs: 0 }],
    ['httpTimeoutMs negative', { httpTimeoutMs: -5 }],
    ['httpTimeoutMs fractional', { httpTimeoutMs: 1.5 }],
    ['blank model', { model: '  ' }],
    ['blank ollamaUrl', { ollamaUrl: '' }],
  ])('rejects invalid config at load: %s', async (_label, config) => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await expect(ctx.plugin(ToolOmni, config)).rejects.toThrow(/tool-omni:/)
  })
})

describe('omni_image execution', () => {
  it('reads the image, posts base64 to the vision path, and returns the model text', async () => {
    const dir = await fixtureDir()
    try {
      const png = join(dir, 'pic.png')
      await writeFile(png, PNG_BYTES)
      const seen = stubOllama(async () => okResponse('a cat on a mat'))
      const { fiber, call } = await mountTools()
      const out = await call('omni_image', { path: png })
      expect(out.isError).toBe(false)
      expect(out.value).toBe('a cat on a mat')
      expect(out.content).toEqual([{ type: 'text', text: 'a cat on a mat' }])
      expect(seen).toHaveLength(1)
      expect(seen[0]?.url).toBe('http://localhost:11434/api/chat')
      const message = seen[0]?.body.messages[0]
      expect(seen[0]?.body.model).toBe('nemotron3:33b')
      expect(seen[0]?.body.stream).toBe(false)
      expect(seen[0]?.body.think).toBe(false)
      expect(message?.content).toBe(ToolOmni.DEFAULT_IMAGE_PROMPT)
      expect(message?.images).toEqual([PNG_BYTES.toString('base64')])
      await fiber.dispose()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('forwards a call-supplied prompt and model override', async () => {
    const dir = await fixtureDir()
    try {
      const png = join(dir, 'pic.png')
      await writeFile(png, PNG_BYTES)
      const seen = stubOllama(async () => okResponse('red'))
      const { fiber, call } = await mountTools()
      const out = await call('omni_image', { path: png, prompt: 'What color is it?', model: 'llama-vision' })
      expect(out.isError).toBe(false)
      expect(seen[0]?.body.model).toBe('llama-vision')
      expect(seen[0]?.body.messages[0]?.content).toBe('What color is it?')
      await fiber.dispose()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('surfaces an Ollama HTTP failure as an error result', async () => {
    const dir = await fixtureDir()
    try {
      const png = join(dir, 'pic.png')
      await writeFile(png, PNG_BYTES)
      stubOllama(async () => new Response('down', { status: 500, statusText: 'Internal Server Error' }))
      const { fiber, call } = await mountTools()
      const out = await call('omni_image', { path: png })
      expect(out.isError).toBe(true)
      expect(out.content).toEqual([{ type: 'text', text: 'Error: omni: Ollama responded with HTTP 500 Internal Server Error' }])
      await fiber.dispose()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('surfaces an unreadable file as an error result', async () => {
    stubOllama(async () => okResponse('unreachable'))
    const { fiber, call } = await mountTools()
    const out = await call('omni_image', { path: '/tmp/dsh-omni-no-such-file.png' })
    expect(out.isError).toBe(true)
    expect(out.content.map(block => (block.type === 'text' ? block.text : '')).join('')).toContain('ENOENT')
    await fiber.dispose()
  })

  it('honors OLLAMA_URL and OMNI_MODEL launch-environment overrides', async () => {
    process.env.OLLAMA_URL = 'http://ollama.test:11435'
    process.env.OMNI_MODEL = 'env-vision'
    const dir = await fixtureDir()
    try {
      const png = join(dir, 'pic.png')
      await writeFile(png, PNG_BYTES)
      const seen = stubOllama(async () => okResponse('ok'))
      const { fiber, call } = await mountTools()
      const out = await call('omni_image', { path: png })
      expect(out.isError).toBe(false)
      expect(seen[0]?.url).toBe('http://ollama.test:11435/api/chat')
      expect(seen[0]?.body.model).toBe('env-vision')
      await fiber.dispose()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('treats an empty environment override as absent', async () => {
    process.env.OLLAMA_URL = ''
    process.env.OMNI_MODEL = ''
    const dir = await fixtureDir()
    try {
      const png = join(dir, 'pic.png')
      await writeFile(png, PNG_BYTES)
      const seen = stubOllama(async () => okResponse('ok'))
      const { fiber, call } = await mountTools()
      await call('omni_image', { path: png })
      expect(seen[0]?.url).toBe('http://localhost:11434/api/chat')
      expect(seen[0]?.body.model).toBe('nemotron3:33b')
      await fiber.dispose()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('omni_audio execution', () => {
  it('converts to wav, posts an OpenAI-compatible audio body, and returns the model text', async () => {
    const dir = await fixtureDir()
    try {
      const wav = join(dir, 'converted.wav')
      await writeFile(wav, Buffer.from('wav-bytes'))
      vi.mocked(media.audioToWav).mockResolvedValue(wav)
      const seen: Array<{ url: string; body: unknown }> = []
      vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
        seen.push({ url: input, body: JSON.parse(init?.body as string) })
        return new Response(JSON.stringify({ choices: [{ message: { content: 'spoken words' } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }))
      const { fiber, call } = await mountTools()
      const out = await call('omni_audio', { path: '/tmp/song.mp3' })
      expect(out.isError).toBe(false)
      expect(out.value).toBe('spoken words')
      expect(vi.mocked(media.audioToWav)).toHaveBeenCalledWith('/tmp/song.mp3', expect.stringContaining('dsh-omni-audio-'), expect.any(AbortSignal))
      expect(seen).toHaveLength(1)
      expect(seen[0]?.url).toBe('http://localhost:11434/v1/chat/completions')
      const message = (seen[0]?.body as {
        messages: Array<{ content: Array<{ type: string; input_audio?: { data: string; format: string } }> }>
      }).messages[0] as { content: Array<{ type: string; input_audio?: { data: string; format: string } }> }
      expect(message.content[0]).toEqual({
        type: 'input_audio',
        input_audio: { data: Buffer.from('wav-bytes').toString('base64'), format: 'wav' },
      })
      expect(message.content[1]).toEqual({ type: 'text', text: ToolOmni.DEFAULT_AUDIO_PROMPT })
      await fiber.dispose()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('surfaces a failed conversion as an error result', async () => {
    vi.mocked(media.audioToWav).mockRejectedValue(new Error('ffmpeg is not installed'))
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: 'unreachable' } }] }), { status: 200 })))
    const { fiber, call } = await mountTools()
    const out = await call('omni_audio', { path: '/tmp/song.mp3' })
    expect(out.isError).toBe(true)
    expect(out.content).toEqual([{ type: 'text', text: 'Error: ffmpeg is not installed' }])
    await fiber.dispose()
  })

  it('uses the whisper backend when whisperPython is configured', async () => {
    const dir = await fixtureDir()
    try {
      const wav = join(dir, 'converted.wav')
      await writeFile(wav, Buffer.from('wav-bytes'))
      vi.mocked(media.audioToWav).mockResolvedValue(wav)
      const run = vi.spyOn(media, 'runCommand').mockResolvedValue({ stdout: '{"text":"正確な書き起こし"}', stderr: '' })
      const { fiber, call } = await mountTools({
        whisperPython: '/home/me/.dsh/whisper/.venv/bin/python',
        whisperDir: '/home/me/.dsh/whisper',
        whisperModel: 'small',
        whisperLanguage: 'ja',
      })
      const out = await call('omni_audio', { path: '/tmp/song.mp3' })
      expect(out.isError).toBe(false)
      expect(out.value).toBe('正確な書き起こし')
      expect(run).toHaveBeenCalledTimes(1)
      const [whisperCall] = run.mock.calls
      expect(whisperCall?.[0].cmd).toBe('/home/me/.dsh/whisper/.venv/bin/python')
      expect(whisperCall?.[0].args).toEqual(['/home/me/.dsh/whisper/transcribe.py', wav, '--model', 'small', '--language', 'ja'])
      expect(whisperCall?.[0].signal).toBeInstanceOf(AbortSignal)
      await fiber.dispose()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('falls back to the default whisper dir and model when only whisperPython is set', async () => {
    const dir = await fixtureDir()
    try {
      const wav = join(dir, 'converted.wav')
      await writeFile(wav, Buffer.from('wav-bytes'))
      vi.mocked(media.audioToWav).mockResolvedValue(wav)
      const run = vi.spyOn(media, 'runCommand').mockResolvedValue({ stdout: '{"text":"ok"}', stderr: '' })
      const { fiber, call } = await mountTools({ whisperPython: '/p/python' })
      const out = await call('omni_audio', { path: '/tmp/song.mp3' })
      expect(out.isError).toBe(false)
      const [whisperCall] = run.mock.calls
      expect(whisperCall?.[0].args).toEqual([ToolOmni.defaultWhisperDir() + '/transcribe.py', wav, '--model', 'large-v3'])
      await fiber.dispose()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('reports a whisper failure as an error result', async () => {
    vi.mocked(media.audioToWav).mockResolvedValue('/tmp/converted.wav')
    vi.spyOn(media, 'runCommand').mockRejectedValue(new Error('python exited 1'))
    const { fiber, call } = await mountTools({ whisperPython: '/p/python' })
    const out = await call('omni_audio', { path: '/tmp/song.mp3' })
    expect(out.isError).toBe(true)
    expect(out.content).toEqual([{ type: 'text', text: 'Error: python exited 1' }])
    await fiber.dispose()
  })
})

describe('omni_video execution', () => {
  it('describes each frame via vision, then synthesizes one summary via a text call', async () => {
    const dir = await fixtureDir()
    try {
      const frameA = join(dir, 'frame-a.jpg')
      const frameB = join(dir, 'frame-b.jpg')
      await writeFile(frameA, Buffer.from('frame-a-bytes'))
      await writeFile(frameB, Buffer.from('frame-b-bytes'))
      vi.mocked(media.sampleVideoFrames).mockResolvedValue([frameA, frameB])
      let visionCount = 0
      const seen = stubOllama(async (call) => {
        if (call.body.messages[0]?.images !== undefined) {
          visionCount += 1
          return okResponse(`frame description ${visionCount}`)
        }
        return okResponse('one cohesive video summary')
      })
      const { fiber, call } = await mountTools()
      const out = await call('omni_video', { path: '/tmp/clip.mp4' })
      expect(out.isError).toBe(false)
      expect(out.value).toBe('one cohesive video summary')
      expect(visionCount).toBe(2)
      expect(seen).toHaveLength(3)
      expect(seen[0]?.body.messages[0]?.images).toBeDefined()
      expect(seen[1]?.body.messages[0]?.images).toBeDefined()
      expect(seen[0]?.body.messages[0]?.images).not.toEqual(seen[1]?.body.messages[0]?.images)
      const summary = seen[2]?.body.messages[0]
      expect(summary?.images).toBeUndefined()
      expect(summary?.content).toContain('Frame 1: frame description 1')
      expect(summary?.content).toContain('Frame 2: frame description 2')
      expect(vi.mocked(media.sampleVideoFrames)).toHaveBeenCalledWith('/tmp/clip.mp4', ToolOmni.DEFAULT_VIDEO_FRAMES, expect.stringContaining('dsh-omni-video-'), expect.any(AbortSignal))
      await fiber.dispose()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('forwards the call-supplied frame count and prompt', async () => {
    const dir = await fixtureDir()
    try {
      const frame = join(dir, 'frame-a.jpg')
      await writeFile(frame, Buffer.from('bytes'))
      vi.mocked(media.sampleVideoFrames).mockResolvedValue([frame])
      const seen = stubOllama(async call => okResponse(call.body.messages[0]?.images !== undefined ? 'a frame' : 'summary'))
      const { fiber, call } = await mountTools()
      const out = await call('omni_video', { path: '/tmp/clip.mp4', prompt: 'What is happening?', frames: 4 })
      expect(out.isError).toBe(false)
      expect(out.value).toBe('summary')
      expect(vi.mocked(media.sampleVideoFrames)).toHaveBeenCalledWith('/tmp/clip.mp4', 4, expect.any(String), expect.any(AbortSignal))
      expect(seen[0]?.body.messages[0]?.content).toBe('What is happening?')
      await fiber.dispose()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('surfaces a failed frame sampling as an error result', async () => {
    vi.mocked(media.sampleVideoFrames).mockRejectedValue(new Error('ffprobe is not installed'))
    stubOllama(async () => okResponse('unreachable'))
    const { fiber, call } = await mountTools()
    const out = await call('omni_video', { path: '/tmp/clip.mp4' })
    expect(out.isError).toBe(true)
    expect(out.content).toEqual([{ type: 'text', text: 'Error: ffprobe is not installed' }])
    await fiber.dispose()
  })
})

describe('omni prompt builders', () => {
  it('builds the video summary prompt from numbered per-frame descriptions', () => {
    expect(buildVideoSummaryPrompt(['first', 'second'])).toBe(
      `${ToolOmni.DEFAULT_VIDEO_SUMMARY_PROMPT}\n\nFrame 1: first\nFrame 2: second`,
    )
  })
})

describe('cancellation through the registry', () => {
  it('reports a pre-aborted call before dispatching the tool body', async () => {
    const controller = new AbortController()
    controller.abort()
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const fiber = await ctx.plugin(ToolOmni, {})
    try {
      const out = await ctx.tools.execute({ signal: controller.signal, callId: ToolCallId('aborted-1'), name: 'omni_image', arguments: { path: '/tmp/x.png' } })
      expect(out.isError).toBe(true)
      expect(out.content).toEqual([{ type: 'text', text: 'Error: tool call aborted before dispatch' }])
    } finally {
      await fiber.dispose()
    }
  })

  it('aborts an in-flight vision request and reports the abort error', async () => {
    const dir = await fixtureDir()
    try {
      const png = join(dir, 'pic.png')
      await writeFile(png, PNG_BYTES)
      vi.stubGlobal('fetch', vi.fn((_input: string, init?: RequestInit) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => { reject(new Error('fetch aborted by caller signal')) }, { once: true })
      })))
      const ctx = new Context()
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      const fiber = await ctx.plugin(ToolOmni, {})
      const controller = new AbortController()
      const pending = ctx.tools.execute({ signal: controller.signal, callId: ToolCallId('aborted-2'), name: 'omni_image', arguments: { path: png } })
      setTimeout(() => { controller.abort() }, 20)
      const out = await pending
      expect(out.isError).toBe(true)
      expect(out.content.map(block => (block.type === 'text' ? block.text : '')).join('')).toContain('request aborted')
      await fiber.dispose()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('readImage helper through the public surface', () => {
  it('re-exports the media and ollama helpers for reuse', () => {
    expect(typeof ToolOmni.runCommand).toBe('function')
    expect(typeof ToolOmni.ollamaChat).toBe('function')
    expect(typeof ToolOmni.parseOllamaContent).toBe('function')
    expect(typeof ToolOmni.buildChatBody).toBe('function')
    expect(ToolOmni.DEFAULT_OLLAMA_URL).toBe('http://localhost:11434')
    expect(ToolOmni.DEFAULT_OMNI_MODEL).toBe('nemotron3:33b')
  })
})
