export function eventText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function hasNotificationIdentity(value: string): boolean {
  if (!value.trim() || value.length > 512) return false;
  return !/[\u0000-\u001f\u007f]/u.test(value);
}

export function notificationBody(value: string): string {
  const readable = value.replace(/[\u0000-\u001f\u007f]/gu, " ");
  return [...readable.replace(/\s+/gu, " ").trim()].slice(0, 600).join("");
}
