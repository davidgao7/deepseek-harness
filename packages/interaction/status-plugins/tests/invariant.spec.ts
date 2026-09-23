import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import * as StatusPluginsInvariant from '@deepseek-ai/dsh-status-plugins/invariant'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'

describe('invariant companion', () => {
  it('registers under the package name with an empty installer', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    await expect(ctx.plugin(StatusPluginsInvariant).await()).resolves.toBeDefined()
  })
})
