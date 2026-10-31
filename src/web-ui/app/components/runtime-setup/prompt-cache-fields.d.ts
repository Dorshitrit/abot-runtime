type SetupPromptCacheState = { promptCache?: boolean; provider?: string; providerType?: string };
export declare function setupPromptCacheState(model?: { promptCache?: boolean }): { promptCache?: boolean };
export declare function updateSetupPromptCacheField(state: SetupPromptCacheState, field: string, value: string | boolean): boolean;
export declare function setupPromptCacheInput(provider: string, enabled?: boolean): { promptCache?: boolean };
export declare function renderSetupPromptCacheField(state: SetupPromptCacheState, readonly?: boolean): string;
