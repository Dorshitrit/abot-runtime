export declare function createNotificationFavicon(options?: {
  documentRoot?: Document;
}): {
  render(snapshot: { supported: boolean; unreadCount: number }): void;
};
