/**
 * Local faster-whisper transcription backend for `omni_audio`. When the
 * deployment configures a whisper venv python (`whisperPython`), the audio
 * tool spawns the project's `transcribe.py` with the converted WAV and parses
 * its JSON stdout (`{"text": "..."}`) instead of calling Ollama — because
 * Ollama ships no official Whisper transcription model, and the Gemma audio
 * path confabulates instead of transcribing. The spawn rides the same
 * injectable runner as the media helpers, so tests exercise parsing and arg
 * building with a fake runner and no real Python.
 * @module @deepseek-ai/dsh-tool-omni/whisper
 */

import type { RunCommand } from './media.ts'

/** Options for one {@link transcribeWithWhisper} call. */
export interface WhisperTranscribeOptions {
  /** Absolute path of the whisper venv's python binary. */
  pythonPath: string
  /** Absolute path of the directory holding `transcribe.py`. */
  scriptDir: string
  /** faster-whisper model id (e.g. `large-v3`, `small`). */
  model: string
  /** Optional source-language code (e.g. `ja`, `zh`); omitted = auto-detect. */
  language?: string
  /** Absolute path of the 16kHz mono WAV to transcribe. */
  audioPath: string
  /** Cancellation signal; firing kills the child. */
  signal: AbortSignal
  /** Command runner; tests inject a fake, production uses the real spawn. */
  run: RunCommand
}

/**
 * Build the transcription command's argument vector.
 * @param options - resolved whisper settings and audio path.
 * @returns `[transcribe.py, audio, --model, model, ...]` in spawn order.
 */
export function buildWhisperArgs(options: Omit<WhisperTranscribeOptions, 'signal' | 'run'>): string[] {
  return [
    `${options.scriptDir}/transcribe.py`,
    options.audioPath,
    '--model',
    options.model,
    ...options.language !== undefined && options.language.length > 0
      ? ['--language', options.language]
      : [],
  ]
}

/**
 * Parse the transcription script's JSON stdout into its text payload.
 * @param stdout - the captured stdout text.
 * @returns the transcribed text.
 * @throws `Error` for non-JSON output or a script-reported `error` field.
 */
export function parseWhisperOutput(stdout: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch (error) {
    throw new Error(`omni: whisper returned invalid JSON: ${stdout.slice(0, 200)}`, { cause: error })
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`omni: whisper returned a non-object response: ${stdout.slice(0, 200)}`)
  }
  const record = parsed as Record<string, unknown>
  if (typeof record.error === 'string' && record.error.length > 0) {
    throw new Error(`omni: whisper error: ${record.error}`)
  }
  if (typeof record.text !== 'string' || record.text.trim().length === 0) {
    throw new Error('omni: whisper returned empty content')
  }
  return record.text
}

/**
 * Transcribe one audio file with the local faster-whisper project.
 * @param options - whisper settings, the audio path, cancellation, and runner.
 * @returns the transcribed text.
 * @throws `Error` when the process fails to start, exits non-zero, is aborted,
 *   or its output cannot be parsed.
 */
export async function transcribeWithWhisper(options: WhisperTranscribeOptions): Promise<string> {
  const result = await options.run({
    cmd: options.pythonPath,
    args: buildWhisperArgs(options),
    signal: options.signal,
  })
  return parseWhisperOutput(result.stdout)
}
