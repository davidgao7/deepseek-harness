/**
 * Pure types of the plugin-enablement domain: the ONE home of the
 * `plugin/inventory-changed` Events declaration, free of this package's
 * runtime imports (node:fs, cordis service classes). Consumer programs
 * (api-remotes' allowlist shape assertion, the host api-proxy, the client
 * remote face) pull this module to see the event's real signature.
 *
 * @module @deepseek-ai/dsh-status-plugins/types
 */

/** Payload of a committed `/plugin` toggle. */
export interface PluginInventoryChangedPayload {
  /** The toggled loader entry id. */
  entryId: string
  /** Whether the entry is enabled after the toggle. */
  enabled: boolean
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * A `/plugin` toggle committed: an override row was appended to the home
     * patch layer and the loader entry was updated. Clients refetch the
     * inventory (`pluginInventory.list()`) on this notification; the payload
     * is the toggle's own identity so a client can optimistically reconcile.
     * @param payload.entryId - the toggled loader entry id.
     * @param payload.enabled - whether the entry is enabled after the toggle.
     * @mode emit
     */
    'plugin/inventory-changed'(payload: PluginInventoryChangedPayload): void
  }
}
