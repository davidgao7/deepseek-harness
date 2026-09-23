/** Package-owned tool-visibility event invariants. @module @deepseek-ai/dsh-status-tools/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-status-tools'

/** Cordis companion plugin name. */
export const name = 'status-tools-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** Validate the package-owned event fields and ignore unrelated events. */
function validateEvent(_ctx: Context, event: SessionEvent, fail: InvariantFailure): void {
  if (event.type !== 'tools/restriction') return
  let previous: string | undefined
  for (const name of event.data.disabled) {
    if (previous !== undefined && name <= previous) {
      fail('tools/restriction carries unsorted or duplicate names')
      return
    }
    previous = name
  }
}

/* jscpd:ignore-start -- the install wiring is the invariant-framework contract shared with every package companion */
/**
 * Install validation that newly appended restriction events stay canonical.
 * Only the committed-event stream is checked: reading retained history
 * synchronously is deprecated in production source.
 */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const event = (args as [Session, SessionEvent])[1]
    validateEvent(ctx, event, fail)
  }, { global: true })
}, { inject: ['sessions'] })
/* jscpd:ignore-end */

/**
 * Register the status-tools invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
