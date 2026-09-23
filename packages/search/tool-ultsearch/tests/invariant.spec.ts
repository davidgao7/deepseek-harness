import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as ToolUltsearchInvariant from '../src/invariant.ts'

describe('tool-ultsearch invariant companion', () => {
  it('registers its explained empty runtime invariant', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    const fiber = await ctx.plugin(ToolUltsearchInvariant)

    expect(() => {
      ctx.invariants.register('@deepseek-ai/dsh-tool-ultsearch', () => {})
    }).toThrow(/already registered/)
    await fiber.dispose()
    await ctx.fiber.dispose()
  })

  it('has no default export (namespace plugin export shape)', () => {
    expect('default' in ToolUltsearchInvariant).toBe(false)
  })
})
