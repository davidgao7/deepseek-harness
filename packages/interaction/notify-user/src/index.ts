/**
 * Host desktop-notification hook for the `ask_user_question` tool. When the
 * agent calls the tool, this plugin fires a best-effort `notify-send` on the
 * host so the user notices the pending question even from another workspace;
 * the call itself proceeds unchanged through the `tools/pre-execute` waterfall.
 * Notifications are fire-and-forget: a missing or failing notification command
 * never affects the agent turn.
 *
 * @module @deepseek-ai/dsh-notify-user
 */

import { spawn } from 'node:child_process'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'

export const name = 'notify-user'
/** Requires the tool runtime whose `tools/pre-execute` waterfall this hook joins. */
export const inject = ['tools']

const DEFAULT_COMMAND = 'notify-send'
const DEFAULT_URGENCY = 'critical'

/**
 * Plugin config, validated by the same-named schemastery schema. Omitted keys
 * resolve to the defaults below before `apply` runs.
 */
export interface Config {
  /** Command that shows the desktop notification (default `notify-send`). */
  command?: string
  /** When false, the plugin loads but never notifies; every call delegates. */
  enabled?: boolean
  /** Urgency flag value passed to the command (default `critical`). */
  urgency?: string
}

export const Config: z<Config> = z.object({
  command: z.string().default(DEFAULT_COMMAND),
  enabled: z.boolean().default(true),
  urgency: z.string().default(DEFAULT_URGENCY),
})

/** Plugin config after schema defaults: every key resolved to a concrete value. */
export interface ResolvedConfig {
  /** Command that shows the desktop notification. */
  command: string
  /** Whether notifications are fired at all. */
  enabled: boolean
  /** Urgency flag value passed to the command. */
  urgency: string
}

/**
 * Extract the notification body from `ask_user_question` arguments: the first
 * question's `question` text, falling back to its `header`. Malformed input —
 * non-object arguments, a non-array `questions` field, a non-object first
 * entry, or an entry with neither usable field — yields undefined rather than
 * throwing.
 * @param args - parsed `ask_user_question` arguments, however malformed.
 * @returns the question text to notify with, or undefined when none exists.
 */
export function extractQuestion(args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined
  const questions = (args as { questions?: unknown }).questions
  if (!Array.isArray(questions)) return undefined
  // Array.isArray narrows `unknown` to `any[]`; re-cast so the first element
  // stays `unknown` and every subsequent check is explicit.
  const first = (questions as unknown[])[0]
  if (typeof first !== 'object' || first === null) return undefined
  const entry = first as { question?: unknown; header?: unknown }
  if (typeof entry.question === 'string' && entry.question.length > 0) return entry.question
  if (typeof entry.header === 'string' && entry.header.length > 0) return entry.header
  return undefined
}

/** Notification title shown above the question body. */
const NOTIFICATION_TITLE = 'DeepSeek Harness'

/**
 * Assemble the notification command's argument vector for one question.
 * `notify-send` reads the title followed by the body text.
 * @param config - resolved plugin config.
 * @param question - notification body text.
 * @returns command arguments in execution order.
 */
export function buildNotifyArgs(config: ResolvedConfig, question: string): string[] {
  return ['--urgency', config.urgency, NOTIFICATION_TITLE, question]
}

/**
 * Fire one desktop notification without blocking or awaiting the child.
 * Failures are contained: a synchronous spawn error is caught, and the child's
 * asynchronous `error` event (for example a missing binary) is swallowed, so a
 * notification problem can never break the agent turn.
 * @param config - resolved plugin config.
 * @param question - notification body text.
 */
export function spawnNotify(config: ResolvedConfig, question: string): void {
  try {
    // Spawn, do not wait: the notification completes on its own schedule.
    const child = spawn(config.command, buildNotifyArgs(config, question))
    // Without a listener, a child `error` event (ENOENT and friends) would
    // surface as an uncaught exception and crash the host process.
    child.on('error', () => {})
  } catch {
    // `spawn` throws synchronously only for invalid arguments; either way the
    // notification must not surface into the agent turn.
  }
}

/**
 * Hook `tools/pre-execute`: notify the user when the agent calls
 * `ask_user_question`, then delegate so the question proceeds normally.
 * Every other call passes straight through to `next()` unchanged.
 * @param ctx - Cordis context with the tool runtime mounted.
 * @param config - validated plugin config; omitted keys carry schema defaults.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved: ResolvedConfig = {
    command: config.command ?? DEFAULT_COMMAND,
    enabled: config.enabled ?? true,
    urgency: config.urgency ?? DEFAULT_URGENCY,
  }
  ctx.on('tools/pre-execute', async (exec: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision> => {
    if (resolved.enabled && exec.name === 'ask_user_question') {
      const question = extractQuestion(exec.arguments)
      if (question !== undefined) {
        // Fire-and-forget: the notification must never block or break the turn.
        spawnNotify(resolved, question)
      }
    }
    return next()
  })
}
