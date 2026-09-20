import type { createRuntimeSetupGuide } from "../runtime-setup-guide.js";

export declare function createBridgeSetupGuide(options: {
  container: HTMLElement;
  conversationRegion: HTMLElement;
  getEnvironmentId?(): string;
  getSetupCommandMode?(): "source" | "package" | undefined;
  copyText?(value: string): Promise<void>;
}): ReturnType<typeof createRuntimeSetupGuide>;
