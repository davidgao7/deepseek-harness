import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as ToolNotifyUser from '@deepseek-ai/dsh-notify-user'
import * as ToolNotifyUserInvariant from '@deepseek-ai/dsh-notify-user/invariant'

const spawnMock = vi.hoisted(() => {
  interface FakeChild {
    on(event: string, handler: (error: Error) => void): FakeChild
    emitError(error: Error): void
  }
  const children: FakeChild[] = []
  const state: {
    calls: Array<{ command: string; args: string[] }>
    throwing: boolean
    children: FakeChild[]
    spawn: (command: string, args: string[]) => FakeChild
  } = {
    calls: [],
    throwing: false,
    children,
    spawn: (command, args) => {
      state.calls.push({ command, args })
      if (state.throwing) throw new Error('spawn failed')
      let handler: ((error: Error) => void) | undefined
      const child: FakeChild = {
        on(event, fn) {
          if (event === 'error') handler = fn
          return child
        },
        emitError(error) {
          handler?.(error)
        },
      }
      children.push(child)
      return child
    },
  }
  return state
})

vi.mock('node:child_process', async importOriginal => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: spawnMock.spawn,
}))

const testToolSignal = new AbortController().signal

/** Minimal `ask_user_question` stand-in so `tools.execute` reaches the pre-execute waterfall. */
const askUserStub = defineTool({
  name: 'ask_user_question',
  description: 'stub for notify-user tests',
  parameters: { questions: { type: 'array' } },
  output: {
    schema: { type: 'object', additionalProperties: true },
    render: () => [{ type: 'text', text: '{}' }],
  },
  async execute() {
    return { answers: [] }
  },
})

/** A second tool proving unrelated calls pass straight through. */
const echoStub = defineTool({
  name: 'echo',
  description: 'stub for notify-user tests',
  parameters: { text: { type: 'string' } },
  output: {
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: value }],
  },
  async execute(args) {
    return args.text ?? ''
  },
})

async function mount(config: ToolNotifyUser.Config = {}) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  ctx.tools.register(askUserStub)
  ctx.tools.register(echoStub)
  const fiber = await ctx.plugin(ToolNotifyUser, config)
  return { ctx, fiber }
}

function execute(ctx: Context, name: string, args: unknown, callId = 'notify-1') {
  return ctx.tools.execute({
    signal: testToolSignal,
    callId: ToolCallId(callId),
    name,
    arguments: args,
  })
}

beforeEach(() => {
  spawnMock.calls.length = 0
  spawnMock.throwing = false
  spawnMock.children.length = 0
})

describe('extractQuestion', () => {
  it('returns the first question text for valid questions', () => {
    expect(ToolNotifyUser.extractQuestion({
      questions: [{ id: 'a', question: 'Continue?' }, { id: 'b', question: 'Skip' }],
    })).toBe('Continue?')
  })

  it('falls back to the header when the question field is missing or empty', () => {
    expect(ToolNotifyUser.extractQuestion({ questions: [{ id: 'a', header: 'Confirm' }] })).toBe('Confirm')
    expect(ToolNotifyUser.extractQuestion({ questions: [{ id: 'a', question: '', header: 'Confirm' }] })).toBe('Confirm')
  })

  it('returns undefined when neither field is a usable string', () => {
    expect(ToolNotifyUser.extractQuestion({ questions: [{ id: 'a' }] })).toBeUndefined()
    expect(ToolNotifyUser.extractQuestion({ questions: [{ id: 'a', question: '', header: '' }] })).toBeUndefined()
    expect(ToolNotifyUser.extractQuestion({ questions: [{ id: 'a', question: 42 }] })).toBeUndefined()
  })

  it('returns undefined for malformed or empty input without throwing', () => {
    expect(ToolNotifyUser.extractQuestion({ questions: [] })).toBeUndefined()
    expect(ToolNotifyUser.extractQuestion({ questions: [42] })).toBeUndefined()
    expect(ToolNotifyUser.extractQuestion({ questions: [null] })).toBeUndefined()
    expect(ToolNotifyUser.extractQuestion({ questions: 'nope' })).toBeUndefined()
    expect(ToolNotifyUser.extractQuestion({})).toBeUndefined()
    expect(ToolNotifyUser.extractQuestion(null)).toBeUndefined()
    expect(ToolNotifyUser.extractQuestion(undefined)).toBeUndefined()
    expect(ToolNotifyUser.extractQuestion('nope')).toBeUndefined()
  })
})

describe('buildNotifyArgs', () => {
  it('builds the notify argument vector from the resolved config', () => {
    expect(ToolNotifyUser.buildNotifyArgs({ command: 'notify-send', enabled: true, urgency: 'critical' }, 'Continue?'))
      .toEqual(['--urgency', 'critical', 'DeepSeek Harness', 'Continue?'])
    expect(ToolNotifyUser.buildNotifyArgs({ command: 'dunstify', enabled: true, urgency: 'normal' }, 'Hi'))
      .toEqual(['--urgency', 'normal', 'DeepSeek Harness', 'Hi'])
  })
})

describe('spawnNotify', () => {
  it('spawns the command fire-and-forget and swallows an async child error', () => {
    ToolNotifyUser.spawnNotify({ command: 'notify-send', enabled: true, urgency: 'critical' }, 'Continue?')

    expect(spawnMock.calls).toEqual([{
      command: 'notify-send',
      args: ['--urgency', 'critical', 'DeepSeek Harness', 'Continue?'],
    }])
    // The attached error listener absorbs a missing-binary child error.
    expect(() => spawnMock.children[0]?.emitError(new Error('ENOENT'))).not.toThrow()
  })

  it('swallows a synchronous spawn failure', () => {
    spawnMock.throwing = true

    expect(() => {
      ToolNotifyUser.spawnNotify(
        { command: 'missing-notifier', enabled: true, urgency: 'critical' },
        'Continue?',
      )
    }).not.toThrow()
  })
})

describe('notify-user hook', () => {
  it('delegates non-ask_user_question calls without notifying', async () => {
    const { ctx } = await mount()
    const result = await execute(ctx, 'echo', { text: 'hi' }, 'notify-echo')

    expect(result.isError).toBe(false)
    expect(spawnMock.calls).toEqual([])
  })

  it('notifies and delegates for ask_user_question when enabled', async () => {
    const { ctx } = await mount()
    const result = await execute(ctx, 'ask_user_question', {
      questions: [{ id: 'a', question: 'Continue?' }],
    })

    expect(result.isError).toBe(false)
    expect(spawnMock.calls).toEqual([{
      command: 'notify-send',
      args: ['--urgency', 'critical', 'DeepSeek Harness', 'Continue?'],
    }])
  })

  it('uses configured command and urgency when provided', async () => {
    const { ctx } = await mount({ command: 'dunstify', urgency: 'normal' })
    const result = await execute(ctx, 'ask_user_question', {
      questions: [{ id: 'a', header: 'Confirm' }],
    })

    expect(result.isError).toBe(false)
    expect(spawnMock.calls).toEqual([{
      command: 'dunstify',
      args: ['--urgency', 'normal', 'DeepSeek Harness', 'Confirm'],
    }])
  })

  it('resolves defaults when apply runs without schema-resolved config keys', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    ctx.tools.register(askUserStub)
    // Direct apply bypasses the cordis config schema, so every optional key is
    // undefined and the `??` defaults inside apply must resolve.
    ToolNotifyUser.apply(ctx, {})

    const result = await execute(ctx, 'ask_user_question', {
      questions: [{ id: 'a', question: 'Continue?' }],
    })

    expect(result.isError).toBe(false)
    expect(spawnMock.calls).toEqual([{
      command: 'notify-send',
      args: ['--urgency', 'critical', 'DeepSeek Harness', 'Continue?'],
    }])
  })

  it('still delegates when no question text is extractable', async () => {
    const { ctx } = await mount()
    const result = await execute(ctx, 'ask_user_question', { questions: [] })

    expect(result.isError).toBe(false)
    expect(spawnMock.calls).toEqual([])
  })

  it('never notifies when disabled, but still delegates', async () => {
    const { ctx } = await mount({ enabled: false })
    const result = await execute(ctx, 'ask_user_question', {
      questions: [{ id: 'a', question: 'Continue?' }],
    })

    expect(result.isError).toBe(false)
    expect(spawnMock.calls).toEqual([])
  })

  it('unregisters the pre-execute listener when its fiber is disposed', async () => {
    const { ctx, fiber } = await mount()
    await execute(ctx, 'ask_user_question', { questions: [{ id: 'a', question: 'Continue?' }] })
    expect(spawnMock.calls).toHaveLength(1)

    await fiber.dispose()

    await execute(ctx, 'ask_user_question', { questions: [{ id: 'a', question: 'Again?' }] }, 'notify-2')
    expect(spawnMock.calls).toHaveLength(1)
  })

  it('has no default export (function-plugin namespace only)', () => {
    expect('default' in ToolNotifyUser).toBe(false)
  })
})

describe('notify-user invariant companion', () => {
  it('registers the package-owned invariant companion', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    await ctx.plugin(ToolNotifyUserInvariant)

    expect(ToolNotifyUserInvariant.name).toBe('notify-user-invariant')
  })
})
