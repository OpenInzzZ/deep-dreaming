/**
 * ui-settings-model-capabilities — host half.
 *
 * The browser half adds a per-provider "模型能力" card to the Models settings
 * page through the shipped `settings.models.provider-card` extension seat,
 * keyed by the pi-ai settings namespace (`llm-pi-ai`): one row per model with
 * the two capabilities the shipped editor leaves out —
 *
 *   - thinking (`reasoningEfforts`): effort levels and their wire spellings,
 *     which `ProviderEditor` refuses by design ("effort is a per-MODEL
 *     capability"), and
 *   - image input (`input`): the same field the shipped model row's 输入类型
 *     checkboxes write, offered here beside the thinking switch so one card
 *     answers "what is this model", with the inherited/declared distinction
 *     the checkbox cannot show.
 *
 * Reads and writes ride the shipped settings transport
 * (`ctx.configForms.get('llm-pi-ai')`: the describe mirror for reads, path
 * operations for writes, with the scope controller owning the
 * `remote.settings` calls), so this half owns no services and no RPC channel.
 * It exists to activate the loader entry: only an activated entry composes its
 * client bundle into the web boot graph.
 */

/** No host-side work: the entry is a delivery vehicle for the browser half. */
export function apply() {}
