import { afterEach, describe, expect, it, vi } from 'vitest'
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  audioToWav,
  exitCodeText,
  makeTempDir,
  probeDuration,
  removeDir,
  runCommand,
  sampleVideoFrames,
  type RunCommand,
  type RunCommandOptions,
} from '../src/media.ts'

const never = new AbortController().signal

async function fixtureDir(prefix = 'dsh-omni-media-'): Promise<string> {
  return await mkdtemp(join(tmpdir(), prefix))
}

afterEach(async () => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('runCommand', () => {
  it('runs a command to completion and captures stdout', async () => {
    const result = await runCommand({ cmd: process.execPath, args: ['-e', 'process.stdout.write("hi")'], signal: never })
    expect(result).toEqual({ stdout: 'hi', stderr: '' })
  })

  it('captures stderr separately', async () => {
    const result = await runCommand({ cmd: process.execPath, args: ['-e', 'process.stderr.write("warn")'], signal: never })
    expect(result).toEqual({ stdout: '', stderr: 'warn' })
  })

  it('rejects a non-zero exit with the exit code', async () => {
    await expect(runCommand({ cmd: process.execPath, args: ['-e', 'process.exit(3)'], signal: never }))
      .rejects.toThrow(/exited with code 3/)
  })

  it('reports a signal-terminated child by its signal', async () => {
    await expect(runCommand({ cmd: process.execPath, args: ['-e', 'process.kill(process.pid, "SIGTERM")'], signal: never }))
      .rejects.toThrow(/exited with code SIGTERM/)
  })

  it('rejects when the executable cannot start', async () => {
    await expect(runCommand({ cmd: 'dsh-omni-no-such-binary-xyz', args: [], signal: never }))
      .rejects.toThrow(/failed to start/)
  })

  it('rejects immediately when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(runCommand({ cmd: process.execPath, args: ['-e', ''], signal: controller.signal }))
      .rejects.toThrow(/not started \(cancelled\)/)
  })

  it('kills the child and rejects when the signal fires mid-run', async () => {
    const controller = new AbortController()
    const pending = runCommand({ cmd: process.execPath, args: ['-e', 'setTimeout(() => {}, 60000)'], signal: controller.signal })
    setTimeout(() => { controller.abort() }, 30)
    await expect(pending).rejects.toThrow(/aborted/)
  })

  it('scrubs credential-bearing names from the child environment and keeps the rest', async () => {
    process.env.DSH_OMNI_TEST_SECRET = 's3cret'
    process.env.DSH_OMNI_TEST_KEEP = 'kept'
    try {
      const result = await runCommand({
        cmd: process.execPath,
        args: ['-e', 'console.log(process.env.DSH_OMNI_TEST_SECRET === undefined, process.env.DSH_OMNI_TEST_KEEP)'],
        signal: never,
      })
      expect(result.stdout).toContain('true kept')
    } finally {
      delete process.env.DSH_OMNI_TEST_SECRET
      delete process.env.DSH_OMNI_TEST_KEEP
    }
  })
})

describe('exitCodeText', () => {
  it('prefers the exit code, then the signal, then unknown', () => {
    expect(exitCodeText(3, null)).toBe('3')
    expect(exitCodeText(null, 'SIGKILL')).toBe('SIGKILL')
    expect(exitCodeText(null, null)).toBe('unknown')
  })
})

describe('probeDuration', () => {
  it('parses the ffprobe duration output', async () => {
    const run: RunCommand = vi.fn(async () => ({ stdout: '12.5\n', stderr: '' }))
    await expect(probeDuration('/tmp/video.mp4', never, run)).resolves.toBe(12.5)
    expect(run).toHaveBeenCalledWith({
      cmd: 'ffprobe',
      args: ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', '/tmp/video.mp4'],
      signal: never,
    })
  })

  it('rejects an unparseable or non-positive duration', async () => {
    const run: RunCommand = vi.fn(async () => ({ stdout: 'nope', stderr: '' }))
    await expect(probeDuration('/tmp/video.mp4', never, run)).rejects.toThrow(/positive duration/)
    const zero: RunCommand = vi.fn(async () => ({ stdout: '0', stderr: '' }))
    await expect(probeDuration('/tmp/video.mp4', never, zero)).rejects.toThrow(/positive duration/)
  })

  it('propagates a failing probe command', async () => {
    const run: RunCommand = vi.fn(async () => { throw new Error('ffprobe missing') })
    await expect(probeDuration('/tmp/video.mp4', never, run)).rejects.toThrow('ffprobe missing')
  })
})

describe('audioToWav', () => {
  it('runs ffmpeg into a 16kHz mono wav and returns its path', async () => {
    const dir = await fixtureDir()
    const run: RunCommand = vi.fn(async () => ({ stdout: '', stderr: '' }))
    try {
      await expect(audioToWav('/tmp/song.mp3', dir, never, run)).resolves.toBe(join(dir, 'audio.wav'))
      expect(run).toHaveBeenCalledWith({
        cmd: 'ffmpeg',
        args: ['-y', '-i', '/tmp/song.mp3', '-vn', '-ar', '16000', '-ac', '1', join(dir, 'audio.wav')],
        signal: never,
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('propagates a failing conversion', async () => {
    const run: RunCommand = vi.fn(async () => { throw new Error('no ffmpeg') })
    await expect(audioToWav('/tmp/song.mp3', '/tmp/out', never, run)).rejects.toThrow('no ffmpeg')
  })
})

describe('sampleVideoFrames', () => {
  it('samples evenly-spaced downscaled frames and returns sorted jpg paths', async () => {
    const dir = await fixtureDir()
    try {
      await writeFile(join(dir, 'frame-001.jpg'), Buffer.from('a'))
      await writeFile(join(dir, 'frame-002.jpg'), Buffer.from('b'))
      await writeFile(join(dir, 'frame-003.jpg'), Buffer.from('c'))
      await writeFile(join(dir, 'notes.txt'), Buffer.from('ignored'))
      const calls: RunCommandOptions[] = []
      const run: RunCommand = vi.fn(async (options: RunCommandOptions) => {
        calls.push(options)
        return { stdout: options.cmd === 'ffprobe' ? '10' : '', stderr: '' }
      })
      const frames = await sampleVideoFrames('/tmp/clip.mp4', 3, dir, never, run)
      expect(frames).toEqual([
        join(dir, 'frame-001.jpg'),
        join(dir, 'frame-002.jpg'),
        join(dir, 'frame-003.jpg'),
      ])
      expect(calls[0]).toMatchObject({ cmd: 'ffprobe' })
      expect(calls[1]).toMatchObject({
        cmd: 'ffmpeg',
        args: ['-y', '-i', '/tmp/clip.mp4', '-vf', "fps=3/10,scale='min(960,iw)':-2", '-frames:v', '3', join(dir, 'frame-%03d.jpg')],
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('clamps the frame count to at least one', async () => {
    const dir = await fixtureDir()
    try {
      await writeFile(join(dir, 'frame-001.jpg'), Buffer.from('a'))
      const run: RunCommand = vi.fn(async (options: RunCommandOptions) => ({ stdout: options.cmd === 'ffprobe' ? '10' : '', stderr: '' }))
      const frames = await sampleVideoFrames('/tmp/clip.mp4', 0, dir, never, run)
      expect(frames).toHaveLength(1)
      expect(run).toHaveBeenLastCalledWith({
        cmd: 'ffmpeg',
        args: ['-y', '-i', '/tmp/clip.mp4', '-vf', "fps=1/10,scale='min(960,iw)':-2", '-frames:v', '1', join(dir, 'frame-%03d.jpg')],
        signal: never,
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('rejects when ffmpeg produced no frame files', async () => {
    const dir = await fixtureDir()
    try {
      const run: RunCommand = vi.fn(async () => ({ stdout: '10', stderr: '' }))
      await expect(sampleVideoFrames('/tmp/clip.mp4', 8, dir, never, run)).rejects.toThrow(/no frames/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('rejects a non-positive duration before running ffmpeg', async () => {
    const run: RunCommand = vi.fn(async () => ({ stdout: '0', stderr: '' }))
    await expect(sampleVideoFrames('/tmp/clip.mp4', 8, '/tmp/out', never, run)).rejects.toThrow(/positive duration/)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('propagates a failing ffmpeg run', async () => {
    const calls = { first: true }
    const run: RunCommand = vi.fn(async () => {
      if (calls.first) {
        calls.first = false
        return { stdout: '10', stderr: '' }
      }
      throw new Error('ffmpeg crashed')
    })
    await expect(sampleVideoFrames('/tmp/clip.mp4', 8, '/tmp/out', never, run)).rejects.toThrow('ffmpeg crashed')
  })
})

describe('temp dir helpers', () => {
  it('creates and removes a temporary directory', async () => {
    const dir = await makeTempDir('dsh-omni-helper-')
    expect(dir).toContain('dsh-omni-helper-')
    await writeFile(join(dir, 'x'), Buffer.from('x'))
    await removeDir(dir)
    await expect(access(dir)).rejects.toThrow()
  })

  it('removing an absent directory is a no-op', async () => {
    await expect(removeDir(join(tmpdir(), 'dsh-omni-definitely-absent'))).resolves.toBeUndefined()
  })
})
