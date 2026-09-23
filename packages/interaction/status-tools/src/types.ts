/**
 * Pure types of the tool-visibility domain: the ONE home of the `toolStatus`
 * projection-key declarations plus their payload types, free of this
 * package's host-side value imports (cordis, zod). Two namespace projections
 * serve it — the package root re-export for host consumers, `./client` (the
 * browser half-entry's re-export) for client aggregates — with zero content
 * duplication.
 *
 * @module @deepseek-ai/dsh-status-tools/types
 */

/** One tool row of the `toolStatus` projection value. */
export interface ToolStatusEntry {
  /** The tool's registered name. */
  name: string
  /** The model-facing description the registry projects. */
  description: string
  /** Whether this session's agent may call the tool right now. */
  enabled: boolean
}

/**
 * Whole `toolStatus` projection value: every currently registered global
 * tool with its per-session enablement, sorted by name. The list reflects
 * the live registry at read time; enablement folds the durable
 * `tools/restriction` events.
 */
export interface ToolStatusView {
  /** Every currently registered global tool, sorted by name. */
  tools: ToolStatusEntry[]
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /**
     * The session's tool-visibility panel: current tools with per-session
     * enablement. Key absence means no tool-visibility service is composed —
     * clients hide the Tools group.
     */
    toolStatus: ToolStatusView
  }
}
