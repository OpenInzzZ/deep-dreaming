/**
 * Browser half of the whale-background patch: injects CSS to display the
 * whale-girl image as a centered background in the conversation area.
 */
window.__ModuleLoader__.load({ id: '@local/dsh-client-whale-background', factory: (require) => {
var module = { exports: {} }; var exports = module.exports;

const PLUGIN_ID = '@local/dsh-client-whale-background';

/* CSS for the whale background */
const CSS = `
[data-conversation-scroll]::before {
  content: '';
  position: fixed;
  top: 50%;
  left: calc(50% + 125px);
  width: min(60vw, 600px);
  height: min(54vh, 540px);
  background-image: url("/whale-background.png");
  background-repeat: no-repeat;
  background-position: center;
  background-size: contain;
  opacity: 0.13;
  pointer-events: none;
  z-index: 0;
  transform: translate(-50%, -50%);
}
`;

/* Inject once per page; the module loader tracks style[data-plugin] tags
   and removes them when the bundle unloads. */
(function () {
  if (typeof document === 'undefined') return
  const tagId = PLUGIN_ID + '/whale-background.css'
  if (document.querySelector('style[data-plugin-css="' + tagId + '"]') !== null) return
  const tag = document.createElement('style')
  tag.dataset.plugin = PLUGIN_ID
  tag.dataset.pluginCss = tagId
  tag.textContent = CSS
  document.head.appendChild(tag)
})();

const inject = ['slots'];

function apply(ctx) {
  // No additional client-side work needed
}

module.exports = { apply, inject };
return module.exports;
} });
