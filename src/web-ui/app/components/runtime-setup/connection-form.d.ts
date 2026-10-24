import type { SetupReasoningState } from "./reasoning-fields.js";
type ConnectionState = SetupReasoningState & {
  providers?: readonly { id: string; label?: string; description?: string; credentialConfigured?: boolean; requiresApiKey?: boolean }[];
  modelId?: string;
  contextWindowTokens?: string | number;
  baseUrl?: string;
  [key: string]: unknown;
};
export declare function renderProviderChoices(state: ConnectionState): string;
export declare function renderConnectionField(options: Record<string, unknown>): string;
export declare function renderConnectionFields(state: ConnectionState): string;
export declare function clearConnectionSecret(container: HTMLElement): void;
export declare function readConnectionSecret(container: HTMLElement): string;
export declare function validateConnectionFields(state: ConnectionState): { valid: boolean; input?: Record<string, unknown>; field?: string; message?: string };
export declare function showConnectionFieldError(container: HTMLElement, field: string, messageId?: string, idPrefix?: string): void;
