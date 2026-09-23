/**
 * The `StatusToolsService` behaviors: the durable fold of whole-value
 * `tools/restriction` events, the live scoped enforcement behind the `/tool`
 * toggle (the agent's tool view excludes a denied tool while the global
 * registry still projects it), and the fold re-application on every fresh
 * agent (agent/created) with graceful skipping of tools that left the
 * registry.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import CommandRuntime, { type CommandResult } from '@deepseek-ai/dsh-commands'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { createScope } from '@deepseek-ai/dsh-scope'
import StatusToolsService from '@deepseek-ai/dsh-status-tools'

/** A minimal callable tool the harness registers under `name`. */
function registerTool(ctx: Context, name: string): void {
  ctx.get('tools')!.register(defineTool({
    name,
    description: `${name} does the thing`,
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {} },
      render: () => [{ type: 'text', text: 'done' }],
    },
    execute: () => Promise.resolve({}),
  }))
}

async function harness(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(AgentRegistry)
  registerTool(ctx, 'search')
  registerTool(ctx, 'fetch')
  await ctx.plugin(StatusToolsService)
  return ctx
}

/** Mint a scoped agent over a live session and publish it (fires agent/created). */
type AgentFixture = { agent: Agent; scope: ReturnType<typeof createScope>; dispose: () => void }

async function agentFor(ctx: Context, session: Session): Promise<AgentFixture> {
  const scope = createScope(ctx, session.id)
  const agent = {
    id: session.id,
    options: {},
    session,
    ctx: scope.ctx,
    status: 'idle',
    send: () => {},
    followup: () => {},
    steer: () => ({ outcome: Promise.resolve({ status: 'rejected' as const }) }),
    inject: () => {},
    cancel() {},
    runMaintenance: (task: (signal: AbortSignal) => Promise<unknown>) => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  } as unknown as Agent
  const dispose = ctx.agents.register(agent)
  return { agent, scope, dispose }
}

/** Run one `/tool` command line through the real command executor. */
async function runTool(ctx: Context, agent: Agent, line: string): Promise<CommandResult> {
  const execution = await ctx.commands.execute(agent, line, [], new AbortController().signal)
  if (execution === undefined) throw new Error('no /tool command registered')
  return execution.result
}

describe('StatusToolsService fold', () => {
  it('starts with every tool enabled and folds the last whole restriction event', async () => {
    const ctx = await harness()
    const session = ctx.sessions.create(SessionId('sess-fold'))
    expect(ctx.statusTools.disabledOf(session)).toEqual([])
    session.append('tools/restriction', { disabled: ['fetch', 'search'] })
    expect(ctx.statusTools.disabledOf(session)).toEqual(['fetch', 'search'])
    session.append('tools/restriction', { disabled: [] })
    expect(ctx.statusTools.disabledOf(session)).toEqual([])
  })
})

describe('StatusToolsService /tool toggle', () => {
  it('disables a tool: live scoped restriction, whole-value event, projection frame', async () => {
    const ctx = await harness()
    const session = ctx.sessions.create(SessionId('sess-toggle'))
    const { agent } = await agentFor(ctx, session)
    // Global view still projects every tool; the agent view is restricted.
    expect(ctx.tools.schemas().map(schema => schema.name).sort()).toEqual(['fetch', 'search'])
    expect(ctx.tools.schemas(agent.id).map(schema => schema.name).sort()).toEqual(['fetch', 'search'])

    const result = await runTool(ctx, agent, '/tool search')
    expect(result).toEqual({ kind: 'success', text: 'tool search disabled' })
    const restrictions = session.snapshotEvents().filter(event => event.type === 'tools/restriction')
    expect(restrictions.map(event => [event.type, event.data])).toEqual([
      ['tools/restriction', { disabled: ['search'] }],
    ])
    expect(ctx.tools.schemas(agent.id).map(schema => schema.name)).toEqual(['fetch'])
    // The global registry is untouched: other sessions still see the tool.
    expect(ctx.tools.schemas().map(schema => schema.name).sort()).toEqual(['fetch', 'search'])
    expect(ctx.sessionProjections.snapshot(session).values.toolStatus).toMatchObject({
      tools: [
        { name: 'fetch', description: 'fetch does the thing', enabled: true },
        { name: 'search', description: 'search does the thing', enabled: false },
      ],
    })
  })

  it('re-enables a tool: lifts the restriction and records the empty fold', async () => {
    const ctx = await harness()
    const session = ctx.sessions.create(SessionId('sess-untoggle'))
    const { agent } = await agentFor(ctx, session)
    await runTool(ctx, agent, '/tool search')
    const result = await runTool(ctx, agent, '/tool search')
    expect(result).toEqual({ kind: 'success', text: 'tool search enabled' })
    const last = session.snapshotEvents().findLast(event => event.type === 'tools/restriction')
    expect(last).toMatchObject({
      type: 'tools/restriction',
      data: { disabled: [] },
    })
    expect(ctx.tools.schemas(agent.id).map(schema => schema.name).sort()).toEqual(['fetch', 'search'])
  })

  it('accumulates several denied tools in one sorted fold', async () => {
    const ctx = await harness()
    const session = ctx.sessions.create(SessionId('sess-multi'))
    const { agent } = await agentFor(ctx, session)
    await runTool(ctx, agent, '/tool fetch')
    await runTool(ctx, agent, '/tool search')
    const last = session.snapshotEvents().findLast(event => event.type === 'tools/restriction')
    expect(last).toMatchObject({
      type: 'tools/restriction',
      data: { disabled: ['fetch', 'search'] },
    })
    expect(ctx.tools.schemas(agent.id)).toHaveLength(0)
  })

  it('bare invocation reports the disabled set; unknown names error', async () => {
    const ctx = await harness()
    const session = ctx.sessions.create(SessionId('sess-report'))
    const { agent } = await agentFor(ctx, session)
    expect(await runTool(ctx, agent, '/tool')).toEqual({ kind: 'success', text: 'disabled tools: (none)' })
    await runTool(ctx, agent, '/tool search')
    expect(await runTool(ctx, agent, '/tool')).toEqual({ kind: 'success', text: 'disabled tools: search' })
    expect(await runTool(ctx, agent, '/tool nope')).toEqual({ kind: 'error', text: 'unknown tool "nope"' })
    expect(session.snapshotEvents().filter(event => event.type === 'tools/restriction')).toHaveLength(1)
  })
})

describe('StatusToolsService agent re-application', () => {
  it('re-applies the durable fold to a fresh agent (restart/resume) before it can call', async () => {
    const ctx = await harness()
    const source = ctx.sessions.create(SessionId('sess-source'))
    source.append('tools/restriction', { disabled: ['search'] })
    const resumed = ctx.sessions.create(SessionId('sess-resumed'), { seed: source.snapshotEvents() })
    const { agent } = await agentFor(ctx, resumed)
    expect(ctx.tools.schemas(agent.id).map(schema => schema.name)).toEqual(['fetch'])
  })

  it('skips folded names whose tool left the registry instead of failing the agent', async () => {
    const ctx = await harness()
    const source = ctx.sessions.create(SessionId('sess-gone-source'))
    source.append('tools/restriction', { disabled: ['search', 'unloaded'] })
    const resumed = ctx.sessions.create(SessionId('sess-gone'), { seed: source.snapshotEvents() })
    const { agent } = await agentFor(ctx, resumed)
    // 'search' is denied; 'unloaded' never existed and is skipped silently.
    expect(ctx.tools.schemas(agent.id).map(schema => schema.name)).toEqual(['fetch'])
  })

  it('cleans the live map when the agent disposes', async () => {
    const ctx = await harness()
    const session = ctx.sessions.create(SessionId('sess-dispose'))
    const { agent, scope, dispose } = await agentFor(ctx, session)
    await runTool(ctx, agent, '/tool search')
    expect(ctx.tools.schemas(agent.id).map(schema => schema.name)).toEqual(['fetch'])
    dispose()
    await scope.dispose()
    // A replacement agent for the same session re-applies the fold fresh.
    const { agent: replacement } = await agentFor(ctx, session)
    expect(ctx.tools.schemas(replacement.id).map(schema => schema.name)).toEqual(['fetch'])
  })

  it('re-applies the fold to agents that existed before the service mounted', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    registerTool(ctx, 'search')
    registerTool(ctx, 'fetch')
    const session = ctx.sessions.create(SessionId('sess-pre-mount'))
    session.append('tools/restriction', { disabled: ['search'] })
    const { agent } = await agentFor(ctx, session)
    expect(ctx.tools.schemas(agent.id).map(schema => schema.name).sort()).toEqual(['fetch', 'search'])
    await ctx.plugin(StatusToolsService)
    expect(ctx.tools.schemas(agent.id).map(schema => schema.name).sort()).toEqual(['fetch'])
  })

  it('fails loud when the agent scope cannot reach the tools registry', async () => {
    const ctx = await harness()
    const session = ctx.sessions.create(SessionId('sess-unreachable'))
    const scope = createScope(ctx, session.id)
    const agent = {
      id: session.id,
      options: {},
      session,
      ctx: new Context(),
      status: 'idle',
      send: () => {},
      followup: () => {},
      steer: () => ({ outcome: Promise.resolve({ status: 'rejected' as const }) }),
      inject: () => {},
      cancel() {},
      runMaintenance: (task: (signal: AbortSignal) => Promise<unknown>) => task(new AbortController().signal),
      whenIdle: () => Promise.resolve(),
    } as unknown as Agent
    ctx.agents.register(agent)
    // Re-application skips the unreachable scope silently; a toggle fails loud.
    await expect(runTool(ctx, agent, '/tool search')).rejects.toThrow(/unreachable from agent/)
    await scope.dispose()
  })
})
