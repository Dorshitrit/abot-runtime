export interface MessageLinkPreview {
  url: string;
  title: string;
  description: string;
  imageUrl: string;
  siteName: string;
}

export declare function createMessageLinkPreviewClient(options?: {
  fetchImpl?: typeof fetch | null;
}): {
  get(url: string): Promise<MessageLinkPreview | null>;
  cancelQueued(): void;
};
