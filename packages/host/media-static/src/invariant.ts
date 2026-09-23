/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-host-media-static`.
 * @module @deepseek-ai/dsh-host-media-static/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-host-media-static'

/** Cordis companion plugin name. */
export const name = 'host-media-static-invariant'
/** Service required before the companion can register. */
export const inject = ['invariants']

/**
 * No runtime invariant: the only owned relation is one webserver prefix route,
 * whose register/release symmetry is covered by the package's
 * real-composition HMR-safety test (the same reason the frontend-static
 * companion is empty — the webserver companion's reserved-path probes cannot
 * see a live media route without colliding with it).
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
