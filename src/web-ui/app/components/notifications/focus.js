export function createNotificationFocus(root) {
  let pending;
  function notificationControlIdentity(element) {
    if (!element || !root.contains(element)) return null;
    const data = element.dataset;
    if (!data) return null;
    if (data.notificationAction)
      return { action: data.notificationAction, id: data.notificationId };
    if (data.notificationDetail)
      return { detail: data.notificationDetail };
    if (data.notificationPreference)
      return { preference: data.notificationPreference };
    if (data.notificationKind)
      return { kind: data.notificationKind };
    return null;
  }
  function matchesNotificationControl(element, target) {
    const data = element.dataset;
    if (target.action)
      return data.notificationAction === target.action && data.notificationId === target.id;
    if (target.detail) return data.notificationDetail === target.detail;
    if (target.preference) return data.notificationPreference === target.preference;
    return data.notificationKind === target.kind;
  }
  return {
    remember() {
      const active = root.ownerDocument.activeElement;
      const current = notificationControlIdentity(active);
      if (current) {
        pending = current;
        return;
      }
      if (active !== root.ownerDocument.body) pending = null;
    },
    restore(busy) {
      if (!canRestoreNotificationFocus(pending, busy)) return;
      const target = pending;
      pending = null;
      if (root.closest("[inert]")) return;
      const active = root.ownerDocument.activeElement;
      if (active !== root.ownerDocument.body && !root.contains(active)) return;
      const controls = [...root.querySelectorAll("button, a, input, summary")];
      const next = controls.find((control) => !control.disabled && matchesNotificationControl(control, target));
      if (next) {
        next.focus({ preventScroll: true });
        return;
      }
      root.querySelector('[data-notification-action="refresh"]')?.focus({ preventScroll: true });
    },
  };
}

function canRestoreNotificationFocus(pending, busy) {
  if (busy) return false;
  return Boolean(pending);
}
