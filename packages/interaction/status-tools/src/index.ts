/**
 * Per-session model-tool visibility over the tool registry's scoped
 * restrictions. The `/tool` command toggles one global tool for the calling
 * agent by writing a live deny restriction on `agent.ctx` and recording the
 * whole folded disabled set as a durable `tools/restriction` session event;
 * the `toolStatus` projection unit serves the current tool set with
 * per-session enablement to clients. A fresh agent (startup, resume, HMR)
 * re-applies the fold, so enforcement is live from the first request and
 * survives session restart by replay — the permission-presets precedent
 * (read projection + write command over one service).
 *
 * @module @deepseek-ai/dsh-status-tools
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { z as zod } from 'zod'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { scopeOf } from '@deepseek-ai/dsh-scope'
// Type-only: pulls the ctx.tools merge (the registry this service drives).
import type {} from '@deepseek-ai/dsh-tools'
// Type-only: resolves ctx.sessionProjections / ctx.commands for the optional children.
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-commands'
import type { ToolStatusView } from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    statusTools: StatusToolsService
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Whole-value toggle fold: the complete, sorted set of global tool names
     * denied for this session's agent. Log-only user intent — enforcement is
     * the live scoped restriction the `/tool` command writes, and the last
     * event is the session's current state.
     */
    'tools/restriction': { disabled: string[] }
  }
}

/** Folded per-session tool-visibility state (plain JSON, persisted-cache precondition). */
export interface ToolStatusState {
  /** Global tool names denied for this session's agent, sorted and unique. */
  disabled: string[]
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    toolStatus: ToolStatusState
  }
}

const toolStatusStateSchema: zod.ZodType<ToolStatusState> = zod.object({
  disabled: zod.array(zod.string()),
}).strict()

/** State for the empty log: every tool enabled. */
const EMPTY_STATE: ToolStatusState = { disabled: [] }

/**
 * One-event fold (the projection unit's `apply`). Uninterested events return
 * the same reference — the registry's change gate.
 * @param state - the folded state before `event`.
 * @param event - one committed session event.
 * @returns the next state; the same reference when the event is not a restriction.
 */
export function applyRestrictionEvent(state: ToolStatusState, event: SessionEvent): ToolStatusState {
  if (event.type === 'tools/restriction') return event.data
  return state
}

/**
 * Owns the per-session tool toggles and their live enforcement. Requires a
 * tool registry and the agent registry; the projection unit and the `/tool`
 * command are optional children over the same service.
 */
export class StatusToolsService extends Service {
  static inject = ['tools', 'sessions', 'agents']

  /** Per-session live deny restrictions: session id → tool name → exact restriction disposer. */
  private readonly live = new Map<SessionId, Map<string, () => void>>()

  constructor(ctx: Context) {
    super(ctx, 'statusTools')
    // Re-apply the fold to agents that already exist (this service may mount
    // after them) and to every agent created later. The old agent's scope
    // restrictions unwind with its disposal, so a fresh agent always
    // re-derives from the durable fold.
    for (const agent of ctx.agents.list()) this.applyForAgent(agent)
    ctx.on('agent/created', ({ agent }) => { this.applyForAgent(agent) })
    ctx.on('agent/disposed', ({ agent }) => { this.live.delete(agent.session.id) })

    // The toolStatus projection unit: fold the whole-value restriction
    // events; the view combines the folded enablement with the LIVE registry
    // tool set (a deployment reload is not a session event). The unit child
    // activates only when a projection registry is composed (headless
    // assemblies stay unaffected).
    const toolStatusViewSchema: zod.ZodType<ToolStatusView> = zod.object({
      tools: zod.array(zod.object({
        name: zod.string(),
        description: zod.string(),
        enabled: zod.boolean(),
      })),
    })
    ctx.inject(['sessionProjections'], (projectionCtx) => {
      projectionCtx.sessionProjections.register<'toolStatus', ToolStatusState>({
        key: 'toolStatus',
        stateSchema: toolStatusStateSchema,
        init: () => EMPTY_STATE,
        apply: applyRestrictionEvent,
        wire: { viewSchema: toolStatusViewSchema, view: state => this.viewOf(state) },
        stateVersion: 1,
      })
    })

    // The /tool command: the one write path a web client uses (the status
    // bar toggle submits this line). The child activates only when a command
    // registry is composed.
    ctx.inject(['commands'], (commandCtx) => {
      commandCtx.commands.register({
        name: 'tool',
        description: 'Toggle a model tool on or off for this session',
        input: { hint: '<tool>' },
        handler: ({ agent, rawInput }) => {
          const name = rawInput.trim()
          if (name === '') {
            const disabled = this.restrictionsOf(agent.session).disabled
            return { kind: 'success', text: `disabled tools: ${disabled.join(', ') || '(none)'}` }
          }
          if (!this.isGlobalTool(name, agent)) {
            return { kind: 'error', text: `unknown tool "${name}"` }
          }
          const disabled = this.toggle(agent, name)
          return { kind: 'success', text: `tool ${name} ${disabled ? 'disabled' : 'enabled'}` }
        },
      })
    })
  }

  /**
   * The session's currently denied global tool names, from the durable fold.
   * @param session - the session whose fold is read.
   * @returns the sorted disabled names.
   */
  /**
   * The session's current restriction state, read from the `toolStatus`
   * projection. Projected state is maintained across resume, so no event
   * history is read (synchronous event reads are deprecated); an assembly
   * without the projection service reports no restrictions.
   * @param session - the session whose restrictions are read.
   * @returns the session's folded restriction state.
   */
  private restrictionsOf(session: Session): ToolStatusState {
    return this.ctx.get('sessionProjections')?.stateOf(session, 'toolStatus') ?? EMPTY_STATE
  }

  /**
   * @returns the sorted disabled names.
   */
  disabledOf(session: Session): readonly string[] {
    return this.restrictionsOf(session).disabled
  }

  /**
   * Project the deployment tool registry with the session's folded
   * enablement for the `toolStatus` wire value. The registry compares
   * consecutive raw view results with `Object.is` to gate publication, so the
   * view takes only state and must not consult live per-session services; the
   * tool list is therefore the deployment registry rather than one agent's
   * scope.
   * @param state - the folded disabled set.
   * @returns the sorted wire payload.
   */
  private viewOf(state: ToolStatusState): ToolStatusView {
    const disabled = new Set(state.disabled)
    const schemas = this.ctx.tools.schemas()
    return {
      tools: schemas
        .map(schema => ({
          name: schema.name,
          description: schema.description,
          enabled: !disabled.has(schema.name),
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    }
  }

  /** Whether `name` is a currently registered tool in the calling agent's scope. */
  private isGlobalTool(name: string, agent: Agent): boolean {
    return this.scopedTools(agent).schemas(scopeOf(agent.ctx)).some(schema => schema.name === name)
  }

  /**
   * The tools registry as resolved from one agent's scope: the traceable
   * service proxy binds its `ctx` to the agent context, so a restriction
   * written through it lands on that agent's scope layer.
   * @param agent - the agent whose scope the restriction targets.
   * @returns the registry bound to the agent scope.
   * @throws when the agent context cannot reach the composed tools registry.
   */
  private scopedTools(agent: Agent): ToolRuntime {
    const tools = agent.ctx.get('tools')
    if (tools === undefined) {
      throw new Error(`status-tools: the tools registry is unreachable from agent "${agent.id}"`)
    }
    return tools
  }

  /**
   * Toggle one global tool for the calling agent: flip the live scoped
   * restriction, then record the whole post-change disabled set. The
   * restriction is applied before the event commits so enforcement leads the
   * publication.
   * @param agent - the agent whose scope the restriction targets.
   * @param name - a currently registered global tool name.
   * @returns whether the tool is disabled after the toggle.
   */
  private toggle(agent: Agent, name: string): boolean {
    const session = agent.session
    const disposers = this.liveFor(session.id)
    const disabled = new Set(this.restrictionsOf(session).disabled)
    if (disabled.has(name)) {
      disposers.get(name)?.()
      disposers.delete(name)
      disabled.delete(name)
      session.append('tools/restriction', { disabled: [...disabled].sort() })
      return false
    }
    disposers.set(name, this.scopedTools(agent).restrict({ deny: [name] }))
    disabled.add(name)
    session.append('tools/restriction', { disabled: [...disabled].sort() })
    return true
  }

  /**
   * Re-apply the durable fold as live restrictions on one fresh agent.
   * Names whose tool left the registry are skipped (their restriction would
   * be meaningless); the fold keeps them, so a re-registration is denied
   * again on the next agent creation.
   * @param agent - the newly created agent.
   */
  private applyForAgent(agent: Agent): void {
    const disposers = new Map<string, () => void>()
    for (const name of this.restrictionsOf(agent.session).disabled) {
      try {
        disposers.set(name, this.scopedTools(agent).restrict({ deny: [name] }))
      } catch {
        // tools.restrict() rejects names outside the current global registry
        // (and the reserved run_code transport); the tool left after its
        // toggle was recorded, so the deny is deferred to its next return.
      }
    }
    this.live.set(agent.session.id, disposers)
  }

  /** The live-restriction map for one session, creating it on first touch. */
  private liveFor(sessionId: SessionId): Map<string, () => void> {
    let disposers = this.live.get(sessionId)
    /* v8 ignore next 3 -- applyForAgent pre-creates each session's map; the create arm covers a toggle racing agent teardown */
    if (disposers === undefined) {
      disposers = new Map()
      this.live.set(sessionId, disposers)
    }
    return disposers
  }
}

export default StatusToolsService
