/**
 * Async ffmpeg/ffprobe helpers for the omni tools. Every orchestration function
 * accepts an injectable command runner (defaulting to the real promisified
 * `spawn`) so tests exercise the orchestration with a fake runner and no real
 * ffmpeg, and every function honors the caller's `AbortSignal` by killing the
 * child process and awaiting its exit before settling.
 * @module @deepseek-ai/dsh-tool-omni/media
 */

import { spawn } from 'node:child_process'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** One completed command's captured output. */
export interface CommandResult {
  stdout: string
  stderr: string
}

/** Arguments for one command invocation. */
export interface RunCommandOptions {
  /** The executable name, resolved through PATH. */
  cmd: string
  /** Arguments passed verbatim (no shell quoting applies). */
  args: string[]
  /** Cancellation signal; firing kills the child with SIGKILL. */
  signal: AbortSignal
}

/** Injectable command runner used by the media helpers. */
export type RunCommand = (options: RunCommandOptions) => Promise<CommandResult>

/** Environment names that may carry credentials and must never reach a child. */
const SENSITIVE_ENV_PATTERN = /KEY|PASSWORD|SECRET|TOKEN/i

/** The parent environment minus credential-bearing names. */
function scrubbedParentEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !SENSITIVE_ENV_PATTERN.test(key)) env[key] = value
  }
  return env
}

/**
 * Human-readable description of a closed child's exit: the exit code, else the
 * terminating signal, else `unknown`.
 * @param code - the exit code, or `null` when a signal terminated the child.
 * @param signal - the terminating signal, or `null` when it exited normally.
 * @returns the first present value as a string, or `unknown`.
 */
export function exitCodeText(code: number | null, signal: NodeJS.Signals | null): string {
  return String(code ?? signal ?? 'unknown')
}

/**
 * Run one command to completion, capturing stdout and stderr. The child starts
 * with the credential-scrubbed parent environment; an abort kills it with
 * SIGKILL and the promise settles only after the child's `close` event, so a
 * cancelled run reaches quiescence before the caller hears about it.
 * @param options - executable, arguments, and cancellation signal.
 * @returns the captured output of a zero-exit run.
 * @throws `Error` when the command cannot start, exits non-zero, or is aborted.
 */
export async function runCommand(options: RunCommandOptions): Promise<CommandResult> {
  return await new Promise<CommandResult>((resolve, reject) => {
    if (options.signal.aborted) {
      reject(new Error(`omni: ${options.cmd} not started (cancelled)`))
      return
    }
    const child = spawn(options.cmd, options.args, { stdio: ['ignore', 'pipe', 'pipe'], env: scrubbedParentEnv() })
    let stdout = ''
    let stderr = ''
    let settled = false
    const settle = (finish: () => void): void => {
      if (settled) return
      settled = true
      options.signal.removeEventListener('abort', onAbort)
      finish()
    }
    const onAbort = (): void => {
      child.kill('SIGKILL')
      settle(() => { reject(new Error(`omni: ${options.cmd} aborted`)) })
    }
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    child.on('error', (error) => {
      settle(() => { reject(new Error(`omni: failed to start ${options.cmd}: ${error.message}`)) })
    })
    child.on('close', (code, signal) => {
      settle(() => {
        if (code === 0) resolve({ stdout, stderr })
        else reject(new Error(`omni: ${options.cmd} exited with code ${exitCodeText(code, signal)}`))
      })
    })
    options.signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Read a media file's duration in seconds via `ffprobe`.
 * @param path - the media file path.
 * @param signal - cancellation forwarded to the command.
 * @param run - the command runner; injectable for tests.
 * @returns the parsed positive duration in seconds.
 * @throws `Error` when ffprobe fails or reports no positive duration.
 */
export async function probeDuration(
  path: string,
  signal: AbortSignal,
  run: RunCommand = runCommand,
): Promise<number> {
  const result = await run({
    cmd: 'ffprobe',
    args: ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', path],
    signal,
  })
  const duration = Number.parseFloat(result.stdout.trim())
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(`omni: could not read a positive duration from ffprobe for ${path}`)
  }
  return duration
}

/**
 * Convert an audio file to a 16kHz mono WAV via `ffmpeg`.
 * @param path - the source audio file path.
 * @param outDir - the directory that receives `audio.wav`.
 * @param signal - cancellation forwarded to the command.
 * @param run - the command runner; injectable for tests.
 * @returns the absolute path of the converted WAV.
 * @throws `Error` when the conversion command fails or is aborted.
 */
export async function audioToWav(
  path: string,
  outDir: string,
  signal: AbortSignal,
  run: RunCommand = runCommand,
): Promise<string> {
  const output = join(outDir, 'audio.wav')
  await run({
    cmd: 'ffmpeg',
    args: ['-y', '-i', path, '-vn', '-ar', '16000', '-ac', '1', output],
    signal,
  })
  return output
}

/**
 * Sample evenly-spaced JPEG frames from a video via `ffprobe` + `ffmpeg`.
 * The frame rate is `frames/duration` so the whole clip is covered, and each
 * frame is downscaled to at most 960px wide for the vision model.
 * @param path - the video file path.
 * @param frames - the requested frame count; clamped to at least 1.
 * @param outDir - the directory that receives `frame-*.jpg` files.
 * @param signal - cancellation forwarded to both commands.
 * @param run - the command runner; injectable for tests.
 * @returns the absolute paths of the sampled frames, sorted.
 * @throws `Error` when probing fails, the clip has no positive duration,
 *   ffmpeg fails or is aborted, or no frame files appear.
 */
export async function sampleVideoFrames(
  path: string,
  frames: number,
  outDir: string,
  signal: AbortSignal,
  run: RunCommand = runCommand,
): Promise<string[]> {
  const duration = await probeDuration(path, signal, run)
  const count = Math.max(1, Math.floor(frames))
  const fps = `${count}/${duration}`
  await run({
    cmd: 'ffmpeg',
    args: ['-y', '-i', path, '-vf', `fps=${fps},scale='min(960,iw)':-2`, '-frames:v', String(count), join(outDir, 'frame-%03d.jpg')],
    signal,
  })
  const entries = await readdir(outDir)
  const framePaths = entries.filter(name => name.endsWith('.jpg')).sort().map(name => join(outDir, name))
  if (framePaths.length === 0) {
    throw new Error(`omni: ffmpeg produced no frames for ${path}`)
  }
  return framePaths
}

/**
 * Create a private (0700) random temporary directory.
 * @param prefix - name prefix; the omni tools use it to identify their scratch dirs.
 * @returns the absolute directory path.
 */
export async function makeTempDir(prefix: string): Promise<string> {
  return await mkdtemp(join(tmpdir(), prefix))
}

/**
 * Recursively remove a directory, ignoring absence.
 * @param path - the directory path.
 * @returns a promise that resolves once removal completes.
 */
export async function removeDir(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true })
}
