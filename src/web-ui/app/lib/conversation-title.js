import { textOf } from "./text-format.js";

/** Session IDs are storage identities, including legacy default titles. */
export function conversationTitle(session, fallback = "Untitled conversation") {
  const displayName = textOf(session?.displayName).trim();
  if (displayName) return displayName;
  const title = textOf(session?.title).trim();
  if (title && title !== textOf(session?.id)) return title;
  return fallback;
}
