export const CONVERSATION_SIDEBAR_MEDIA_QUERY = "(min-width: 1260px)";

export function resolveConversationSidebarLayout(workspace, activeSheet, wide) {
  if (workspace !== "chat") {
    return { docked: false, drawerOpen: false, visible: false };
  }
  if (wide) {
    return { docked: true, drawerOpen: false, visible: true };
  }
  const drawerOpen = activeSheet === "sessions";
  return { docked: false, drawerOpen, visible: drawerOpen };
}
