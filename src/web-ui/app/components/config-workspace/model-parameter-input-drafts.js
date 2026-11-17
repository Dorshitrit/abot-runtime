// Invalid text belongs to the editor, never to the persisted generation config.
// Replacing a config on reset, reload, or raw apply also discards its editor drafts.
const draftsByConfig = new WeakMap();

function draftKey(path, key) {
  return JSON.stringify([...path, key]);
}

export function readModelParameterInputDraft(config, path, key) {
  return draftsByConfig.get(config)?.get(draftKey(path, key));
}

export function modelParameterInputDraftEntries(config) {
  return [...(draftsByConfig.get(config) ?? [])].map(([identity, draft]) => {
    const path = JSON.parse(identity);
    return { path: path.slice(0, -1), key: path.at(-1), draft };
  });
}

export function setModelParameterInputDraft(config, path, key, draft) {
  if (!draft) {
    draftsByConfig.get(config)?.delete(draftKey(path, key));
    return;
  }
  if (!draftsByConfig.has(config)) draftsByConfig.set(config, new Map());
  draftsByConfig.get(config).set(draftKey(path, key), draft);
}

export function modelParameterInputValidationError(config) {
  return draftsByConfig.get(config)?.values().next().value?.error ?? "";
}
