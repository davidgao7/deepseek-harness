/**
 * The `toolStatus` projection unit and the `/tool` command: mounting the
 * status-tools service beside the projection registry serves the whole
 * current tool set with per-session enablement (folded from the whole-value
 * `tools/restriction` events, live registry list at view time); the command
 * child registers `/tool` whose handler toggles through the service;
 * compositions without either registry are unaffected; unmounting the
 * service removes the key (HMR safety).
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createScope, scopeOf } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import CommandRuntime, { type CommandResult } from '@deepseek-ai/dsh-commands'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import StatusToolsService from '@deepseek-ai/dsh-status-tools'
import type { ToolStatusView } from '@deepseek-ai/dsh-status-tools'

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

async function harness(options: { withStatus?: boolean } = {}): Promise<{ ctx: Context; session: Session }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(AgentRegistry)
  registerTool(ctx, 'search')
  registerTool(ctx, 'fetch')
  if (options.withStatus !== false) await ctx.plugin(StatusToolsService)
  return { ctx, session: ctx.sessions.create(SessionId('status-projected')) }
}

async function agentFor(ctx: Context, session: Session, scope = createScope(ctx, session.id)): Promise<Agent> {
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
  ctx.agents.register(agent)
  return agent
}

/** Run one `/tool` command line through the real command executor. */
async function runTool(ctx: Context, agent: Agent, line: string): Promise<CommandResult> {
  const execution = await ctx.commands.execute(agent, line, [], new AbortController().signal)
  if (execution === undefined) throw new Error('no /tool command registered')
  return execution.result
}

describe('toolStatus projection unit', () => {
  it('serves every registered tool enabled, sorted by name', async () => {
    const { ctx, session } = await harness()
    const value = ctx.sessionProjections.snapshot(session).values.toolStatus
    expect(value).toMatchObject({
      tools: [
        { name: 'fetch', description: 'fetch does the thing', enabled: true },
        { name: 'search', description: 'search does the thing', enabled: true },
      ],
    })
  })

  it('folds restriction events and notifies the change feed per toggle', async () => {
    const { ctx, session } = await harness()
    const changes: { key: string; value: unknown; seq: number }[] = []
    ctx.sessionProjections.onChanged((_session, key, value, seq) => {
      changes.push({ key, value, seq })
    })
    const agent = await agentFor(ctx, session)
    await runTool(ctx, agent, '/tool search')
    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({
      key: 'toolStatus',
      value: {
        tools: [
          { name: 'fetch', enabled: true },
          { name: 'search', enabled: false },
        ],
      },
    })
    // Unrelated event: same-reference apply, no notification.
    session.append('turn/start', { turn: 1 })
    expect(changes).toHaveLength(1)
  })

  it('reflects a tool registered after the service mounted (live registry at view time)', async () => {
    const { ctx, session } = await harness()
    registerTool(ctx, 'zed')
    const value = ctx.sessionProjections.snapshot(session).values.toolStatus as ToolStatusView
    expect(value.tools.map(tool => tool.name)).toEqual(['fetch', 'search', 'zed'])
  })

  it('has no toolStatus key without the service, and drops it on unload (HMR safety)', async () => {
    const { ctx, session } = await harness({ withStatus: false })
    expect(ctx.sessionProjections.snapshot(session).values.toolStatus).toBeUndefined()
    const fiber = await ctx.plugin(StatusToolsService)
    expect(ctx.sessionProjections.snapshot(session).values.toolStatus).toBeDefined()
    await fiber.dispose()
    expect(ctx.sessionProjections.snapshot(session).values.toolStatus).toBeUndefined()
    expect(ctx.commands.find({} as Agent, 'tool')).toBeUndefined()
  })

  it('serves the tool set resolved through the live agent scope, not the deployment registry', async () => {
    // A preset-mounted tool set registers on the preset's standing scope
    // (ScopedLayers keys the layer by the registering scope); the agent's
    // scope parents to it, so the tool is an inherited contribution the
    // agent's view resolves. The projection view must follow that scope
    // when an agent is live for the session.
    const { ctx, session } = await harness()
    const mount = createScope(ctx, { preset: 'standing' })
    registerTool(mount.ctx, 'scoped-only')
    const agentScope = createScope(ctx, { session: session.id }, { parent: scopeOf(mount.ctx)! })
    const agent = await agentFor(ctx, session, agentScope)
    expect(scopeOf(agent.ctx)).toBe(scopeOf(agentScope.ctx))
    const value = ctx.sessionProjections.snapshot(session).values.toolStatus as ToolStatusView
    expect(value.tools.map(tool => tool.name)).toEqual(['fetch', 'scoped-only', 'search'])
    // Without a live agent (cold reads) the deployment registry is the view.
    const cold = ctx.sessionProjections.snapshot(ctx.sessions.create(SessionId('status-cold'))).values
      .toolStatus as ToolStatusView
    expect(cold.tools.map(tool => tool.name)).toEqual(['fetch', 'search'])
  })

  it('accepts /tool names registered only in the agent scope chain', async () => {
    const { ctx, session } = await harness()
    const mount = createScope(ctx, { preset: 'standing' })
    registerTool(mount.ctx, 'scoped-only')
    const agentScope = createScope(ctx, { session: session.id }, { parent: scopeOf(mount.ctx)! })
    const agent = await agentFor(ctx, session, agentScope)
    const result = await runTool(ctx, agent, '/tool scoped-only')
    expect(result).toMatchObject({ kind: 'success' })
    const value = ctx.sessionProjections.snapshot(session).values.toolStatus as ToolStatusView
    expect(value.tools.find(tool => tool.name === 'scoped-only')?.enabled).toBe(false)
  })

  it('restores the fold from a persisted checkpoint (cold read)', async () => {
    const { ctx, session } = await harness()
    const agent = await agentFor(ctx, session)
    await runTool(ctx, agent, '/tool fetch')
    const checkpoint = ctx.sessionProjections.checkpoint(session)
    const tail = session.snapshotEvents().slice(0)
    const restored = ctx.sessionProjections.restore(checkpoint, tail, SessionLogOffset(0), session.header, session.inheritedEventCount)
    expect(restored.snapshot.values.toolStatus).toMatchObject({
      tools: [
        { name: 'fetch', enabled: false },
        { name: 'search', enabled: true },
      ],
    })
  })
})

describe('status-tools composition', () => {
  it('registers no /tool command without a command registry', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    registerTool(ctx, 'search')
    await ctx.plugin(StatusToolsService)
    expect(ctx.get('commands')).toBeUndefined()
  })

  it('registers no projection unit without a projection registry', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(CommandRuntime)
    await ctx.plugin(AgentRegistry)
    registerTool(ctx, 'search')
    await ctx.plugin(StatusToolsService)
    expect(ctx.get('sessionProjections')).toBeUndefined()
  })
})
