import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionSeq } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import * as StatusInvariant from '@deepseek-ai/dsh-status-tools/invariant'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(InvariantRegistry, { enabled: true })
  await ctx.plugin(StatusInvariant)
  return ctx
}

function restrictionEvent(disabled: string[]): SessionEvent {
  return { type: 'tools/restriction', seq: SessionSeq(0), time: 0, data: { disabled } }
}

describe('status-tools invariants', () => {
  it('accepts canonical restriction events and ignores other session data', async () => {
    const ctx = await setup()
    expect(() => { ctx.emit('session/event', {} as Session, restrictionEvent([])) }).not.toThrow()
    expect(() => { ctx.emit('session/event', {} as Session, restrictionEvent(['fetch', 'search'])) }).not.toThrow()
    expect(() => { ctx.emit('session/event', {} as Session, {
      type: 'turn/end', seq: 0, time: 0, data: {},
    } as SessionEvent) }).not.toThrow()
    expect(() => { ctx.emit('tools/change') }).not.toThrow()
  })

  it('rejects an unsorted restriction event', async () => {
    const ctx = await setup()
    expect(() => { ctx.emit('session/event', {} as Session, restrictionEvent(['search', 'fetch'])) })
      .toThrow(/unsorted or duplicate names/)
  })

  it('rejects a duplicated restriction event', async () => {
    const ctx = await setup()
    expect(() => { ctx.emit('session/event', {} as Session, restrictionEvent(['search', 'search'])) })
      .toThrow(/unsorted or duplicate names/)
  })

  it('rejects an unsorted event already present on late registration', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create()
    session.append('tools/restriction', { disabled: ['search', 'fetch'] })
    await ctx.plugin(InvariantRegistry, { enabled: true })

    await expect(ctx.plugin(StatusInvariant).then(() => undefined)).rejects.toThrow(/unsorted or duplicate names/)
  })
})
