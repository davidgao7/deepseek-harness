/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-status-plugins`.
 * @module @deepseek-ai/dsh-status-plugins/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-status-plugins'

/** Cordis companion plugin name. */
export const name = 'status-plugins-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: a pure writer that appends id-targeted override
 * rows to the home patch layer and emits a payload-free-forwarded
 * notification; the loader's own patch watcher owns reload validity and the
 * command/run lifecycle events record every toggle invocation in the
 * session log.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
