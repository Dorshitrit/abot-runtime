export interface ConversationFilePreview {
  name: string;
  mimeType: string;
  size: number;
  kind: "text" | "image" | "unsupported";
  operation: "created" | "updated";
  content?: string;
  truncated: boolean;
  location?: string;
  downloadAvailable: boolean;
  nativeOpenAvailable?: boolean;
}
