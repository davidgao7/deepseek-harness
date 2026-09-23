/**
 * Host-only Context merge for the plugin-enablement service. Kept out of
 * `./types` (which the client remote face imports) because the member type
 * resolves through the package root and would drag the service's node:fs
 * imports into browser programs.
 *
 * @module @deepseek-ai/dsh-status-plugins/context
 */

export {}

declare module '@deepseek-ai/cordis' {
  interface Context {
    statusPlugins: import('@deepseek-ai/dsh-status-plugins').StatusPluginsService
  }
}
