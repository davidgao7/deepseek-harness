/**
 * The `StatusPluginsService` and the `/plugin` command over a REAL booted
 * loader+include tree: toggling applies through the entry's own `update`
 * (the plugin fiber disposes and re-initializes — asserted through the
 * plugin's apply counter), appends an id-targeted override row to the home
 * patch file (asserted by reading the file back), and emits
 * `plugin/inventory-changed`. Unknown ids and group ids error; bare
 * invocation reports the disabled set.
 */

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentPresets from '@deepseek-ai/dsh-agent-preset-registry'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { createScope } from '@deepseek-ai/dsh-scope'
import CommandRuntime, { type CommandResult } from '@deepseek-ai/dsh-commands'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import { boot } from '@deepseek-ai/dsh-app-boot'
import StatusPluginsService from '@deepseek-ai/dsh-status-plugins'
import type {} from '@deepseek-ai/dsh-status-plugins/types'

const COUNTING_PLUGIN = `
export default function counting() {
  globalThis.__statusPluginsApplies = (globalThis.__statusPluginsApplies ?? 0) + 1
}
`

async function harness(): Promise<{ ctx: Context; dir: string; applies: () => number }> {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-status-plugins-'))
  writeFileSync(join(dir, 'counting.mjs'), COUNTING_PLUGIN)
  writeFileSync(join(dir, 'cordis.yml'), [
    '- id: counting',
    '  name: ./counting.mjs',
    '- id: some-group',
    '  name: cordis:group',
    '  config:',
    '    - id: group-child',
    '      name: ./counting.mjs',
  ].join('\n'))
  vi.stubEnv('DSH_HOME', join(dir, 'home'))
  const ctx = await boot('dsh-test-status-plugins', join(dir, 'cordis.yml'))
  await ctx.loader.await()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentPresets, { default: 'standard' })
  await ctx.plugin(StatusPluginsService)
  return {
    ctx,
    dir,
    applies: () => (globalThis as Record<string, unknown>)['__statusPluginsApplies'] as number,
  }
}

async function agentFor(ctx: Context, session: Session): Promise<Agent> {
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
  ctx.agents.register(agent)
  return agent
}

async function runPlugin(ctx: Context, agent: Agent, line: string): Promise<CommandResult> {
  const execution = await ctx.commands.execute(agent, line, [], new AbortController().signal)
  if (execution === undefined) throw new Error('no /plugin command registered')
  return execution.result
}

afterEach(() => {
  vi.unstubAllEnvs()
  delete (globalThis as Record<string, unknown>)['__statusPluginsApplies']
})

describe('StatusPluginsService /plugin command', () => {
  it('disables a plugin: fiber dispose, patch row, notification', async () => {
    const { ctx, dir, applies } = await harness()
    const session = ctx.sessions.create(SessionId('sess-plugin'))
    const agent = await agentFor(ctx, session)
    expect(applies()).toBe(2) // counting + group-child both booted.

    const events: unknown[] = []
    ctx.on('plugin/inventory-changed', (payload) => { events.push(payload) })
    const result = await runPlugin(ctx, agent, '/plugin include:counting')
    expect(result).toEqual({ kind: 'success', text: 'plugin include:counting disabled' })
    // The counting entry's fiber is disposed; group-child stays alive (the
    // counter never decrements — no re-apply happened).
    const entry = [...ctx.loader.entries()].find(candidate => candidate.id === 'include:counting')
    expect(entry?.fiber).toBeUndefined()
    expect(entry?.disabled).toBe(true)
    expect(applies()).toBe(2)
    const patch = await readFile(join(dir, 'home', 'cordis.patch.yml'), 'utf8')
    expect(patch).toContain('- id: "counting"')
    expect(patch).toContain('disabled: true')
    expect(events).toEqual([{ entryId: 'include:counting', enabled: false }])
  })

  it('re-enables a plugin: fiber re-initialization and a false row', async () => {
    const { ctx, dir, applies } = await harness()
    const session = ctx.sessions.create(SessionId('sess-plugin-on'))
    const agent = await agentFor(ctx, session)
    await runPlugin(ctx, agent, '/plugin include:counting')
    const result = await runPlugin(ctx, agent, '/plugin include:counting')
    expect(result).toEqual({ kind: 'success', text: 'plugin include:counting enabled' })
    // The re-initialized fiber ran the plugin body again (2 boots + 1 re-init).
    const entry = [...ctx.loader.entries()].find(candidate => candidate.id === 'include:counting')
    expect(entry?.fiber).toBeDefined()
    expect(entry?.disabled).toBe(false)
    expect(applies()).toBe(3)
    const patch = await readFile(join(dir, 'home', 'cordis.patch.yml'), 'utf8')
    expect(patch).toContain('disabled: true')
    expect(patch).toContain('disabled: false')
  })

  it('refuses toggling a plugin its agent preset composes', async () => {
    const { ctx, dir } = await harness()
    const session = ctx.sessions.create(SessionId('sess-plugin-preset'))
    const agent = await agentFor(ctx, session)
    // A registered preset composes the same module as the root `counting`
    // entry — the loader entry's toggle does not govern that standing mount,
    // so the command must refuse before writing anything.
    const unregister = await ctx.agentPresets.register({
      id: 'mine',
      plugins: [{ id: 'preset-counting', name: './counting.mjs' }],
    })

    const result = await runPlugin(ctx, agent, '/plugin include:counting')
    expect(result).toMatchObject({
      kind: 'error',
      text: 'plugin include:counting is mounted by agent preset "mine" — edit its agent.cordis.yml instead',
    })
    // The refusal writes nothing: no patch row, no fiber change.
    const entry = [...ctx.loader.entries()].find(candidate => candidate.id === 'include:counting')
    expect(entry?.fiber).toBeDefined()
    expect(entry?.disabled).toBe(false)
    await expect(readFile(join(dir, 'home', 'cordis.patch.yml'), 'utf8')).rejects.toThrow()
    // Tear the standing mount down: the agent-preset mount table is
    // module-global, and a surviving record would refuse the same package's
    // toggles in every later test of this file.
    await unregister()
  })

  it('bare invocation reports the disabled set; unknown and group ids error', async () => {
    const { ctx, dir } = await harness()
    const session = ctx.sessions.create(SessionId('sess-plugin-report'))
    const agent = await agentFor(ctx, session)
    expect(await runPlugin(ctx, agent, '/plugin')).toEqual({ kind: 'success', text: 'disabled plugins: (none)' })
    await runPlugin(ctx, agent, '/plugin include:counting')
    expect(await runPlugin(ctx, agent, '/plugin')).toEqual({ kind: 'success', text: 'disabled plugins: include:counting' })
    expect(await runPlugin(ctx, agent, '/plugin nope')).toEqual({ kind: 'error', text: 'unknown plugin "nope"' })
    // Group entries are not toggleable (they are absent from the inventory).
    expect(await runPlugin(ctx, agent, '/plugin some-group')).toEqual({ kind: 'error', text: 'unknown plugin "some-group"' })
    expect(await readFile(join(dir, 'home', 'cordis.patch.yml'), 'utf8')).toContain('"counting"')
  })
})

describe('StatusPluginsService composition', () => {
  it('registers no /plugin command without a command registry', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-status-plugins-none-'))
    writeFileSync(join(dir, 'counting.mjs'), COUNTING_PLUGIN)
    writeFileSync(join(dir, 'cordis.yml'), '- id: counting\n  name: ./counting.mjs\n')
    const ctx = await boot('dsh-test-status-plugins-none', join(dir, 'cordis.yml'))
    await ctx.loader.await()
    await ctx.plugin(StatusPluginsService)
    expect(ctx.get('commands')).toBeUndefined()
  })

  it('fails loud when the home patch file cannot be written', async () => {
    const { ctx } = await harness()
    const session = ctx.sessions.create(SessionId('sess-plugin-unwritable'))
    const agent = await agentFor(ctx, session)
    // ENOTDIR is deterministic for every privilege level: the append path is
    // not a directory, so the non-ENOENT failure arm propagates.
    vi.stubEnv('DSH_HOME', '/dev/null')
    await expect(runPlugin(ctx, agent, '/plugin include:counting')).rejects.toThrow()
    // The entry is untouched when the write fails after the runtime apply.
    const entry = [...ctx.loader.entries()].find(candidate => candidate.id === 'include:counting')
    expect(entry?.disabled).toBe(false)
    expect(entry?.fiber).toBeDefined()
  })
})
