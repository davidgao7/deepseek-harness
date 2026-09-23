import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as ToolOmni from '@deepseek-ai/dsh-tool-omni'
import {
  buildWhisperArgs,
  parseWhisperOutput,
  transcribeWithWhisper,
  type WhisperTranscribeOptions,
} from '../src/whisper.ts'
import type { RunCommand } from '../src/media.ts'

const never = new AbortController().signal

function baseOptions(overrides: Partial<WhisperTranscribeOptions> = {}): WhisperTranscribeOptions {
  return {
    pythonPath: '/home/me/.dsh/whisper/.venv/bin/python',
    scriptDir: '/home/me/.dsh/whisper',
    model: 'large-v3',
    audioPath: '/tmp/audio.wav',
    signal: never,
    run: async () => ({ stdout: '{"text":"transcribed"}', stderr: '' }),
    ...overrides,
  }
}

describe('buildWhisperArgs', () => {
  it('builds the transcribe command with model and audio path', () => {
    const args = buildWhisperArgs({
      pythonPath: '/p/python',
      scriptDir: '/p/whisper',
      model: 'large-v3',
      audioPath: '/tmp/a.wav',
    })
    expect(args).toEqual(['/p/whisper/transcribe.py', '/tmp/a.wav', '--model', 'large-v3'])
  })

  it('appends the language flag when provided', () => {
    const args = buildWhisperArgs({
      pythonPath: '/p/python',
      scriptDir: '/p/whisper',
      model: 'small',
      language: 'ja',
      audioPath: '/tmp/a.wav',
    })
    expect(args).toEqual(['/p/whisper/transcribe.py', '/tmp/a.wav', '--model', 'small', '--language', 'ja'])
  })
})

describe('parseWhisperOutput', () => {
  it('returns the transcribed text from a well-formed response', () => {
    expect(parseWhisperOutput('{"text":"こんにちは"}')).toBe('こんにちは')
  })

  it('rejects invalid JSON output', () => {
    expect(() => parseWhisperOutput('not json')).toThrow(/invalid JSON/)
  })

  it('rejects a non-object response', () => {
    expect(() => parseWhisperOutput('"text"')).toThrow(/non-object response/)
  })

  it('surfaces a script-reported error', () => {
    expect(() => parseWhisperOutput('{"error":"model download failed"}'))
      .toThrow(/whisper error: model download failed/)
  })

  it.each(['{"text":""}', '{"text":"   "}', '{}'])('rejects empty content: %s', (stdout) => {
    expect(() => parseWhisperOutput(stdout)).toThrow(/empty content/)
  })
})

describe('transcribeWithWhisper', () => {
  it('runs the python command and returns the parsed text', async () => {
    const run = vi.fn<RunCommand>(async () => ({ stdout: '{"text":"spoken words"}', stderr: '' }))
    const text = await transcribeWithWhisper(baseOptions({ run }))
    expect(text).toBe('spoken words')
    expect(run).toHaveBeenCalledWith({
      cmd: '/home/me/.dsh/whisper/.venv/bin/python',
      args: ['/home/me/.dsh/whisper/transcribe.py', '/tmp/audio.wav', '--model', 'large-v3'],
      signal: never,
    })
  })

  it('forwards the language flag when configured', async () => {
    const run = vi.fn<RunCommand>(async () => ({ stdout: '{"text":"x"}', stderr: '' }))
    await transcribeWithWhisper(baseOptions({ language: 'ja', run }))
    expect(run.mock.calls[0]?.[0].args).toContain('--language')
    expect(run.mock.calls[0]?.[0].args).toContain('ja')
  })

  it('surfaces the parse failure from a bad run output', async () => {
    const run = vi.fn<RunCommand>(async () => ({ stdout: 'garbage', stderr: '' }))
    await expect(transcribeWithWhisper(baseOptions({ run }))).rejects.toThrow(/invalid JSON/)
  })

  it('passes a rejected runner through', async () => {
    const run = vi.fn<RunCommand>(async () => { throw new Error('python not found') })
    await expect(transcribeWithWhisper(baseOptions({ run }))).rejects.toThrow('python not found')
  })
})

describe('registerOmniAudioTool whisper defaults', () => {
  it('resolves missing dir/model to the package defaults on a direct call', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const media = await import('../src/media.ts')
    const toWav = vi.spyOn(media, 'audioToWav').mockResolvedValue('/tmp/conv.wav')
    const run = vi.spyOn(media, 'runCommand')
      .mockResolvedValue({ stdout: '{"text":"defaults"}', stderr: '' })
    try {
      // Direct call with a partial resolved config: the `??` fallbacks fire
      // because no schemastery schema application fills the defaults.
      ToolOmni.registerOmniAudioTool(ctx, { baseUrl: 'http://localhost:11434', model: 'm' }, 1000, {
        whisperPython: '/p/python',
      })
      const out = await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: ToolCallId('whisper-defaults'),
        name: 'omni_audio',
        arguments: { path: '/tmp/x.mp3' },
      })
      expect(out.isError).toBe(false)
      expect(out.value).toBe('defaults')
      const [call] = run.mock.calls
      expect(call?.[0].args[2]).toBe('--model')
      expect(call?.[0].args[3]).toBe(ToolOmni.DEFAULT_WHISPER_MODEL)
      expect(call?.[0].args[0]).toBe(`${ToolOmni.defaultWhisperDir()}/transcribe.py`)
      expect(toWav).toHaveBeenCalled()
    } finally {
      run.mockRestore()
      toWav.mockRestore()
      await ctx.fiber?.dispose?.()
    }
  })
})
