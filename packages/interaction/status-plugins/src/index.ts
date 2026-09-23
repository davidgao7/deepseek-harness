/**
 * Per-deployment plugin enablement over the loader's watched user patch
 * layer. The `/plugin` command toggles one non-group loader entry: it
 * applies the change synchronously through the entry's own `update`
 * (disposing or re-initializing the plugin fiber), appends an id-targeted
 * override row to the home patch file (`$DSH_HOME/cordis.patch.yml`, the
 * launcher's global user layer) so the toggle survives restart by
 * re-composition, and emits `plugin/inventory-changed` so clients refetch
 * the inventory. The launcher's own patch watcher then re-applies the same
 * row idempotently — the change is declarative, never a flattened
 * re-composition of the bundle layers. An entry whose package an agent
 * preset composes is refused: its runtime state is owned by the preset's
 * standing mount, and the composition file (`agent.cordis.yml`) is the only
 * write path.
 *
 * @module @deepseek-ai/dsh-status-plugins
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type { Entry } from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
// Type-only: resolves the optional agent-preset roster through `ctx.get`.
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
// Type-only: resolves ctx.commands for the optional child.
import type {} from '@deepseek-ai/dsh-commands'
// The `plugin/inventory-changed` Events declaration lives in src/types.ts
// and the Context merge in src/context.ts (host-only); the emit below is
// typed through the same program.
import type {} from './types.ts'
import type {} from './context.ts'

/** Home patch filename — the launcher's global user layer (its `homePatchPath()` convention). */
const HOME_PATCH_FILENAME = 'cordis.patch.yml'
/** Header written when the home patch file does not exist yet. */
const HOME_PATCH_HEADER = '# dsh user patch layer — the loader watches this file; edits apply live.\n'

/**
 * Owns the plugin enable/disable write path and its notification. Requires
 * the loader; the `/plugin` command is an optional child over the same
 * service.
 */
export class StatusPluginsService extends Service {
  static inject = ['loader']

  constructor(ctx: Context) {
    super(ctx, 'statusPlugins')
    ctx.inject(['commands'], (commandCtx) => {
      commandCtx.commands.register({
        name: 'plugin',
        description: 'Toggle a plugin on or off for this deployment',
        input: { hint: '<plugin>' },
        handler: async ({ rawInput }) => {
          const id = rawInput.trim()
          if (id === '') {
            const disabled = this.entries()
              .filter(entry => entry.disabled)
              .map(entry => entry.id)
            return { kind: 'success', text: `disabled plugins: ${disabled.join(', ') || '(none)'}` }
          }
          const entry = this.entries().find(candidate => candidate.id === id)
          if (entry === undefined) {
            return { kind: 'error', text: `unknown plugin "${id}"` }
          }
          // A plugin an agent preset composes runs through the preset's
          // standing mount; the loader entry's disable state does not govern
          // it, so toggling here would either double-mount the plugin or
          // change nothing. The composition file is the write path.
          const presetId = await this.presetOwningPackage(entry.options.name)
          if (presetId !== undefined) {
            return {
              kind: 'error',
              text: `plugin ${id} is mounted by agent preset "${presetId}" — edit its agent.cordis.yml instead`,
            }
          }
          const willDisable = !entry.disabled
          await this.writeToggle(entry, willDisable)
          ctx.emit('plugin/inventory-changed', { entryId: id, enabled: !willDisable })
          return { kind: 'success', text: `plugin ${id} ${willDisable ? 'disabled' : 'enabled'}` }
        },
      })
    })
  }

  /** Non-group loader entries, the same set `pluginInventory.list()` serves. */
  private entries(): Entry[] {
    return [...this.ctx.loader.entries()].filter(entry => !entry.options.group)
  }

  /**
   * The id of the agent preset whose composition mounts one package, when a
   * roster is composed. Read from the roster's composition inventory, which
   * parses each preset rather than composing it, so this cannot activate a
   * preset early; a deployment without the roster reports no owner.
   * @param moduleName - module specifier the loader entry names.
   * @returns the owning preset id, or undefined when no preset mounts it.
   */
  private async presetOwningPackage(moduleName: string): Promise<string | undefined> {
    const presets = this.ctx.get('agentPresets')
    if (presets === undefined) return undefined
    for (const composition of await presets.compositionInventory()) {
      if (composition.rows.some(row => row.moduleName === moduleName)) return composition.id
    }
    return undefined
  }

  /**
   * Apply one toggle: persist an id-targeted override row in the home patch
   * file first, then update the loader entry (dispose or re-initialize the
   * plugin fiber at runtime). The row carries the entry's CONFIG-row id
   * (`options.id`, e.g. `counting`), not the prefixed tree id
   * (`include:counting`), because the loader's patch algorithm matches rows
   * by the former. Persisting first means a failed write leaves the entry
   * untouched; if the runtime apply itself fails, the launcher's patch
   * watcher re-applies the row on its reload, so the toggle still lands.
   * @param entry - the loader entry to toggle (already validated).
   * @param disabled - the state to write.
   * @throws when the file write fails.
   */
  private async writeToggle(entry: Entry, disabled: boolean): Promise<void> {
    const file = join(resolveDshHome(), HOME_PATCH_FILENAME)
    const row = `- id: ${JSON.stringify(entry.options.id)}\n  disabled: ${disabled}\n`
    try {
      await appendFile(file, `\n${row}`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') throw error
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, `${HOME_PATCH_HEADER}${row}`)
    }
    await entry.update({ disabled })
  }
}

export default StatusPluginsService
