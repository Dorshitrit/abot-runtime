import { clearPluginSecretInputs } from "./configuration-fields.js";

/** Keep the actual controls mounted; never copy entered passwords into state. */
export function createPluginConfigurationDraft() {
  let fields = null;
  let owner = null;
  function clear() {
    clearPluginSecretInputs(fields);
    fields = null;
    owner = null;
  }
  function capture(root, review, busy) {
    if (busy || !review || owner !== review) {
      clear();
      return;
    }
    fields =
      root?.querySelector("[data-plugin-configuration-fields]") || fields;
  }
  function restore(root, review, busy) {
    if (busy || !review) {
      clear();
      return;
    }
    const replacement = root.querySelector(
      "[data-plugin-configuration-fields]",
    );
    if (owner === review && fields && replacement)
      replacement.replaceWith(fields);
    fields = root.querySelector("[data-plugin-configuration-fields]");
    owner = review;
  }
  return { capture, restore, clear };
}
