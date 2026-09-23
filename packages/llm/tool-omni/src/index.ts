/**
 * Model-facing `omni_image`, `omni_audio`, and `omni_video` tools that send
 * local media on the host to a LOCAL Ollama vision model (`/api/chat`) for
 * understanding. This package owns the model-facing schemas, prompt guidance,
 * media preprocessing (ffmpeg/ffprobe), and the Ollama HTTP call; the model
 * and base URL come from config with `OMNI_MODEL`/`OLLAMA_URL` launch
 * environment overrides, resolved through `launchEnvironmentOf`.
 * @module @deepseek-ai/dsh-tool-omni
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { ollamaAudio, ollamaChat } from './ollama.ts'
import { audioToWav, makeTempDir, removeDir, runCommand, sampleVideoFrames } from './media.ts'
import { transcribeWithWhisper } from './whisper.ts'

export { ollamaAudio, ollamaChat, parseOllamaContent, parseOpenAiContent, buildChatBody, buildOpenAiAudioBody, OllamaError, errorMessage } from './ollama.ts'
export type { OllamaAudioOptions, OllamaChatBody, OllamaChatOptions, OllamaOpenAiAudioBody } from './ollama.ts'
export { buildWhisperArgs, parseWhisperOutput, transcribeWithWhisper } from './whisper.ts'
export type { WhisperTranscribeOptions } from './whisper.ts'
export { runCommand, probeDuration, audioToWav, sampleVideoFrames, makeTempDir, removeDir, exitCodeText } from './media.ts'
export type { CommandResult, RunCommand, RunCommandOptions } from './media.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-omni'

/** Service required by the omni tools. */
export const inject = ['tools']

/** Default local Ollama base URL. */
export const DEFAULT_OLLAMA_URL = 'http://localhost:11434'
/** Default Ollama vision model. */
export const DEFAULT_OMNI_MODEL = 'nemotron3:33b'
/** Default per-call HTTP timeout (ms); local vision inference is slow. */
export const DEFAULT_HTTP_TIMEOUT_MS = 270_000
/** Default number of frames `omni_video` samples. */
export const DEFAULT_VIDEO_FRAMES = 8

/** Default image prompt. */
export const DEFAULT_IMAGE_PROMPT = 'Describe this image in detail, including subjects, actions, text, and visual context.'
/** Default audio prompt. */
export const DEFAULT_AUDIO_PROMPT = 'Transcribe or describe the audio content in detail, including speech, speakers, and non-speech sounds.'
/** Default per-frame video prompt. */
export const DEFAULT_VIDEO_FRAME_PROMPT = 'Describe this video frame in detail, including subjects, actions, text, scene, and motion cues.'
/** Instruction prefix for the video summary synthesis call. */
export const DEFAULT_VIDEO_SUMMARY_PROMPT = 'Synthesize one cohesive summary of this video from the per-frame descriptions below. Keep the summary concise, chronological, and faithful to what the frames show.'

/** Default faster-whisper model used when a deployment sets no `whisperModel`. */
export const DEFAULT_WHISPER_MODEL = 'large-v3'

/**
 * Default whisper project directory (holds `transcribe.py`), under the OS home.
 * @returns `~/.dsh/whisper` with the real home directory expanded.
 */
export function defaultWhisperDir(): string {
  return `${homedir()}/.dsh/whisper`
}

/** Plugin config: which omni tools to register and the Ollama endpoint. */
export interface Config {
  /** Ollama base URL. Defaults to `http://localhost:11434`; `OLLAMA_URL` overrides it. */
  ollamaUrl?: string
  /** Ollama vision model. Defaults to `nemotron3:33b`; `OMNI_MODEL` overrides it. */
  model?: string
  /** Per-call HTTP timeout (ms). Defaults to 270000. */
  httpTimeoutMs?: number
  /** Register `omni_image`. Defaults to true. */
  image?: boolean
  /** Register `omni_audio`. Defaults to true. */
  audio?: boolean
  /** Register `omni_video`. Defaults to true. */
  video?: boolean
  /**
   * Absolute path of the faster-whisper venv python (e.g.
   * `~/.dsh/whisper/.venv/bin/python`). When set, `omni_audio` transcribes
   * through the local whisper project instead of the Ollama audio path.
   * Defaults to unset (Ollama path).
   */
  whisperPython?: string
  /**
   * Directory holding the whisper project's `transcribe.py`. Defaults to
   * `~/.dsh/whisper`.
   */
  whisperDir?: string
  /** faster-whisper model id used by `omni_audio`. Defaults to `large-v3`. */
  whisperModel?: string
  /** Optional source-language code (e.g. `ja`, `zh`); omitted = auto-detect. */
  whisperLanguage?: string
}

export const Config: z<Config> = z.object({
  ollamaUrl: z.string().default(DEFAULT_OLLAMA_URL),
  model: z.string().default(DEFAULT_OMNI_MODEL),
  httpTimeoutMs: z.number().default(DEFAULT_HTTP_TIMEOUT_MS),
  image: z.boolean().default(true),
  audio: z.boolean().default(true),
  video: z.boolean().default(true),
  whisperPython: z.string(),
  whisperDir: z.string().default(defaultWhisperDir()),
  whisperModel: z.string().default(DEFAULT_WHISPER_MODEL),
  whisperLanguage: z.string(),
})

/** Complete config after schemastery applies every field default. */
type ResolvedConfig = Required<Config>

/** The Ollama endpoint the omni tools use, after config + environment resolution. */
export interface OmniEndpoint {
  /** Base URL, trailing-slash-normalized at call time. */
  baseUrl: string
  /** Model name used when a tool call does not override it. */
  model: string
}

/**
 * Resolve the effective Ollama endpoint. The `OLLAMA_URL`/`OMNI_MODEL` launch
 * environment entries win over the configured values; an empty env value counts
 * as absent. `launchEnvironmentOf` falls back to the inherited process
 * environment when no launcher booted the composition.
 * @param ctx - context whose launch environment is resolved.
 * @param config - the schema-defaulted plugin config.
 * @returns the effective endpoint.
 */
export function resolveEndpoint(ctx: Context, config: ResolvedConfig): OmniEndpoint {
  const env = launchEnvironmentOf(ctx)
  return {
    baseUrl: env.get('OLLAMA_URL')?.value || config.ollamaUrl,
    model: env.get('OMNI_MODEL')?.value || config.model,
  }
}

/** Load-time validation that fails loud on unusable config. */
function validateConfig(resolved: ResolvedConfig): void {
  if (!Number.isInteger(resolved.httpTimeoutMs) || resolved.httpTimeoutMs < 1) {
    throw new Error('tool-omni: httpTimeoutMs must be a positive integer')
  }
  if (resolved.model.trim().length === 0) throw new Error('tool-omni: model must be a non-empty string')
  if (resolved.ollamaUrl.trim().length === 0) throw new Error('tool-omni: ollamaUrl must be a non-empty string')
}

/**
 * Register the enabled omni tools. Each tool's disposer is fiber-scoped (the
 * effect-based tool registry cleans up on dispose), so no manual teardown is
 * needed; disable a tool entirely by setting its flag to false in config.
 */
export function apply(ctx: Context, config: Config): void {
  // schemastery (Config) has already filled every defaulted field.
  const resolved = config as ResolvedConfig
  validateConfig(resolved)
  const endpoint = resolveEndpoint(ctx, resolved)
  if (resolved.image) registerOmniImageTool(ctx, endpoint, resolved.httpTimeoutMs)
  if (resolved.audio) registerOmniAudioTool(ctx, endpoint, resolved.httpTimeoutMs, resolved)
  if (resolved.video) registerOmniVideoTool(ctx, endpoint, resolved.httpTimeoutMs)
}

/** Read a file and return its raw base64 payload. */
async function readBase64(path: string): Promise<string> {
  const bytes = await readFile(path)
  return bytes.toString('base64')
}

/**
 * Run one Ollama vision call with the resolved endpoint, the tool's optional
 * model override, and the per-call timeout.
 * @param endpoint - the resolved Ollama endpoint.
 * @param model - the call's optional model override.
 * @param content - the prompt sent with the media payload.
 * @param imageB64 - the base64 media bytes placed in the request's `images` field.
 * @param signal - the caller's cancellation signal.
 * @param timeoutMs - the per-call HTTP timeout.
 * @returns the model's text response.
 */
function visionCall(
  endpoint: OmniEndpoint,
  model: string | undefined,
  content: string,
  imageB64: string,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<string> {
  return ollamaChat({
    baseUrl: endpoint.baseUrl,
    model: model ?? endpoint.model,
    content,
    imageB64,
    signal,
    timeoutMs,
  })
}

/** Shared `model` parameter declaration for the media tools. */
const MEDIA_MODEL_PARAM: { type: 'string'; description: string } = {
  type: 'string',
  description: 'Optional Ollama model override. Defaults to the configured omni model.',
}

/** Shared `prompt` parameter declaration for the media tools. */
function mediaPromptParam(promptDescription: string): { type: 'string'; description: string } {
  return { type: 'string', description: promptDescription }
}

/** Shared string-output and concurrency declarations for the media tools. */
function mediaToolOutput() {
  return {
    output: {
      schema: { type: 'string' as const },
      render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
    },
    // Media reads do not mutate parent-agent state.
    isConcurrencySafe: () => true,
  }
}

/**
 * Register the `omni_image` tool: read a local image file and send it to the
 * vision model.
 * @param ctx - context whose tool registry receives the definition.
 * @param endpoint - the resolved Ollama endpoint.
 * @param timeoutMs - the per-call HTTP timeout.
 */
export function registerOmniImageTool(ctx: Context, endpoint: OmniEndpoint, timeoutMs: number): void {
  ctx.tools.register(defineTool({
    name: 'omni_image',
    description: 'MUST-CALL tool for any uploaded or referenced image file (PNG/JPEG/WebP/GIF) on the host. Sends the image bytes to a local Ollama vision model and returns its description or answer. Use it to understand image content; never guess what an image contains.',
    parameters: {
      path: { type: 'string', required: true, description: 'Host path to the image file (PNG, JPEG, WebP, or GIF).' },
      prompt: mediaPromptParam('Optional instruction for what to extract or describe about the image. Defaults to a general description.'),
      model: MEDIA_MODEL_PARAM,
    },
    ...mediaToolOutput(),
    async execute(args, exec) {
      const image = await readBase64(args.path)
      return await visionCall(endpoint, args.model, args.prompt ?? DEFAULT_IMAGE_PROMPT, image, exec.signal, timeoutMs)
    },
  }))
}

/**
 * Register the `omni_audio` tool: convert a local audio file to 16kHz mono WAV
 * and transcribe or understand it. When `whisperPython` is configured, the
 * tool spawns the local faster-whisper project (accurate transcription);
 * otherwise it sends the WAV through the Ollama OpenAI-compatible audio input.
 * @param ctx - context whose tool registry receives the definition.
 * @param endpoint - the resolved Ollama endpoint.
 * @param timeoutMs - the per-call HTTP timeout.
 * @param resolved - the schema-defaulted plugin config (whisper settings).
 */
export function registerOmniAudioTool(ctx: Context, endpoint: OmniEndpoint, timeoutMs: number, resolved: Partial<ResolvedConfig>): void {
  // Direct programmatic mounts (tests, other plugins) may skip the schemastery
  // Config application, so undefined whisper fields resolve to their defaults
  // here rather than throwing at trim time.
  const whisperPython = (resolved.whisperPython ?? '').trim()
  const whisperEnabled = whisperPython.length > 0
  const whisperDir = (resolved.whisperDir ?? defaultWhisperDir()).trim()
  const whisperModel = (resolved.whisperModel ?? DEFAULT_WHISPER_MODEL).trim()
  const whisperLanguage = (resolved.whisperLanguage ?? '').trim()
  ctx.tools.register(defineTool({
    name: 'omni_audio',
    description: whisperEnabled
      ? 'MUST-CALL tool for any uploaded or referenced audio file on the host. Converts the audio to a 16kHz mono WAV with ffmpeg and transcribes it with the local faster-whisper model, returning the verbatim text. Requires ffmpeg on PATH and the configured whisper backend.'
      : 'MUST-CALL tool for any uploaded or referenced audio file on the host. Converts the audio to a 16kHz mono WAV with ffmpeg and sends it to the local Ollama model through the OpenAI-compatible audio input for transcription or understanding. Requires ffmpeg on PATH.',
    parameters: {
      path: { type: 'string', required: true, description: 'Host path to the audio file.' },
      prompt: mediaPromptParam('Optional instruction for what to transcribe or describe about the audio. Defaults to a full transcription-style description.'),
      model: MEDIA_MODEL_PARAM,
    },
    ...mediaToolOutput(),
    async execute(args, exec) {
      const dir = await makeTempDir('dsh-omni-audio-')
      try {
        const wav = await audioToWav(args.path, dir, exec.signal)
        if (whisperEnabled) {
          return await transcribeWithWhisper({
            pythonPath: whisperPython,
            scriptDir: whisperDir,
            model: whisperModel,
            ...whisperLanguage.length > 0 ? { language: whisperLanguage } : {},
            audioPath: wav,
            signal: exec.signal,
            run: runCommand,
          })
        }
        const payload = await readBase64(wav)
        return await ollamaAudio({
          baseUrl: endpoint.baseUrl,
          model: args.model ?? endpoint.model,
          content: args.prompt ?? DEFAULT_AUDIO_PROMPT,
          audioB64: payload,
          signal: exec.signal,
          timeoutMs,
        })
      } finally {
        await removeDir(dir)
      }
    },
  }))
}

/**
 * Build the text prompt for the video summary synthesis call from per-frame descriptions.
 * @param descriptions - one model response per sampled frame, in chronological order.
 * @returns the numbered-frame summary prompt sent as a plain-text Ollama call.
 */
export function buildVideoSummaryPrompt(descriptions: string[]): string {
  const numbered = descriptions.map((description, index) => `Frame ${index + 1}: ${description}`)
  return `${DEFAULT_VIDEO_SUMMARY_PROMPT}\n\n${numbered.join('\n')}`
}

/**
 * Register the `omni_video` tool: sample evenly-spaced frames with
 * ffmpeg/ffprobe, describe each with the vision model, then synthesize one
 * cohesive summary with a plain-text Ollama call.
 * @param ctx - context whose tool registry receives the definition.
 * @param endpoint - the resolved Ollama endpoint.
 * @param timeoutMs - the per-call HTTP timeout (applies to every call).
 */
export function registerOmniVideoTool(ctx: Context, endpoint: OmniEndpoint, timeoutMs: number): void {
  ctx.tools.register(defineTool({
    name: 'omni_video',
    description: 'MUST-CALL tool for any uploaded or referenced video file on the host. Samples up to `frames` evenly-spaced frames with ffmpeg and ffprobe, describes each with the local Ollama vision model, then returns one cohesive summary of the whole clip. Requires ffmpeg and ffprobe on PATH.',
    parameters: {
      path: { type: 'string', required: true, description: 'Host path to the video file.' },
      prompt: mediaPromptParam('Optional instruction applied to each sampled frame. Defaults to a detailed per-frame description.'),
      frames: { type: 'integer', default: DEFAULT_VIDEO_FRAMES, description: 'Number of evenly-spaced frames to sample. Defaults to 8; more frames cost more vision calls.' },
      model: MEDIA_MODEL_PARAM,
    },
    ...mediaToolOutput(),
    async execute(args, exec) {
      const dir = await makeTempDir('dsh-omni-video-')
      try {
        const framePaths = await sampleVideoFrames(args.path, args.frames ?? DEFAULT_VIDEO_FRAMES, dir, exec.signal)
        const framePrompt = args.prompt ?? DEFAULT_VIDEO_FRAME_PROMPT
        const descriptions: string[] = []
        for (const framePath of framePaths) {
          const payload = await readBase64(framePath)
          descriptions.push(await visionCall(endpoint, args.model, framePrompt, payload, exec.signal, timeoutMs))
        }
        return await ollamaChat({
          baseUrl: endpoint.baseUrl,
          model: args.model ?? endpoint.model,
          content: buildVideoSummaryPrompt(descriptions),
          signal: exec.signal,
          timeoutMs,
        })
      } finally {
        await removeDir(dir)
      }
    },
  }))
}
