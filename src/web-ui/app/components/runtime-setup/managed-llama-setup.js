import { createManagedLlamaBinding, renderManagedLlama } from "./managed-llama.js";
import { createManagedServerSetup } from "../managed-llama-server/wizard.js";

/** Shared wizard integration. The host owns its form and final configuration save. */
export function createManagedLlamaSetup({ container, state, client, getEnvironmentId,
  isAvailable, isHostBusy, isForward, modelField, idPrefix, onReady }) {
  if (client?.getManagedLlamaServer) return createManagedServerSetup({ container, state, client, getEnvironmentId,
    isAvailable, isHostBusy, isForward, modelField, onReady });
  let selection = null;
  const binding = createManagedLlamaBinding({
    client, getEnvironmentId,
    onChange: () => { invalidate(); mount(); },
    onReady: (ready) => {
      if (!isAvailable() || binding.isBusy()) return;
      selection = binding.state.ready;
      state.managedLlama = true;
      state[modelField] = ready.model;
      state.baseUrl = ready.baseUrl;
      state.contextWindowTokens = String(ready.contextWindowTokens);
      onReady(ready);
    },
  });
  function invalidate() {
    selection = null;
    state.managedLlama = false;
  }
  function reset() {
    invalidate();
    binding.reset({ notify: false });
  }
  function blocked() {
    const current = binding.state;
    if (!isAvailable() || current.mode !== "managed") return false;
    if (!state.managedLlama || !selection || selection !== current.ready) return true;
    return state[modelField] !== selection.model || state.baseUrl !== selection.baseUrl ||
      Number(state.contextWindowTokens) !== selection.contextWindowTokens;
  }
  function gate() {
    const busy = binding.isBusy();
    const needsSelection = blocked();
    for (const control of container.querySelectorAll('input, select, button')) {
      if (control.closest('[data-managed-llama-slot]')) continue;
      const locked = busy || (needsSelection && isForward(control));
      if (locked && !control.hasAttribute('data-managed-disabled')) {
        control.setAttribute('data-managed-disabled', control.disabled ? 'true' : 'false');
        control.disabled = true;
        continue;
      }
      if (locked || !control.hasAttribute('data-managed-disabled')) continue;
      control.disabled = control.getAttribute('data-managed-disabled') === 'true';
      control.removeAttribute('data-managed-disabled');
    }
  }
  function mount() {
    const slot = container.querySelector('[data-managed-llama-slot]');
    if (slot) {
      slot.hidden = !client || !isAvailable();
      if (!slot.hidden) slot.innerHTML = renderManagedLlama(binding.state, idPrefix);
    }
    gate();
  }
  function change(event) {
    const field = event.target.dataset?.managedLlamaField;
    if (!field) return false;
    if (!isAvailable() || isHostBusy()) return true;
    invalidate();
    void binding.input(field, event.target.value);
    return true;
  }
  function click(event) {
    const action = event.target.closest?.('[data-managed-llama-action]')?.dataset.managedLlamaAction;
    if (!action) return false;
    event.preventDefault();
    if (!isAvailable() || isHostBusy()) return true;
    if (action !== 'use') invalidate();
    void binding.action(action);
    return true;
  }
  return { binding, invalidate, reset, blocked, gate, mount, change, click };
}
