export interface ModelSelectorOption {
  value: string;
  label: string;
  providerId: string;
  providerLabel: string;
  usingChatgptPlan: boolean;
  executionPolicy?: string;
}

export declare function modelSelectorOptions(
  profiles: readonly { id: string; label?: unknown; provider?: unknown; providerId?: unknown; executionPolicy?: unknown }[],
): ModelSelectorOption[];

export declare function groupModelSelectorOptions<T extends { providerId?: string; providerLabel?: string }>(
  options: readonly T[],
): { id: string; label: string; options: T[] }[];
