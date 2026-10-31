import type { ChatgptAccountRequests } from "../../services/runtime-web-client/chatgpt-accounts.js";
export declare function createChatgptSetupBinding(options: {
  state: Record<string, unknown>; client?: ChatgptAccountRequests; getEnvironmentId(): string;
  getContainer(): HTMLElement | null; getProvider(): { type: string; existing?: boolean }; getAccountRef(): string;
  render(): void; modelField: string;
}): { mount(): void; reset(): void };
