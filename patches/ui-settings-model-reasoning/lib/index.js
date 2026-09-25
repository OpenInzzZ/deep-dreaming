/**
 * ui-settings-model-reasoning — host half.
 *
 * The browser half adds a per-provider "思考配置" card to the Models settings
 * page: the shipped `settings.models.provider-card` extension seat, keyed by
 * the pi-ai settings namespace (`llm-pi-ai`), where hand-declared routes
 * declare their per-model thinking switch and effort levels.
 *
 * Reads and writes ride the shipped settings transport (`ctx.settingsScope`,
 * bound to the `llm-pi-ai` namespace: the describe mirror for reads, path
 * operations for writes, with the scope controller owning the `remote.settings`
 * calls), so this half owns no services and no RPC channel.
 * It exists to activate the loader entry: only an activated entry composes its
 * client bundle into the web boot graph.
 */

/** No host-side work: the entry is a delivery vehicle for the browser half. */
export function apply() {}
