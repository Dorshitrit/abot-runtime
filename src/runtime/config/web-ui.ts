import type { RuntimeConfigFile } from "./types.js";

export const DEFAULT_WEB_UI_PAGE_SIZE = 20;

export function buildWebUiConfig(config: RuntimeConfigFile): { pageSize: number } {
  const webUi = config.webUi as { pageSize?: number } | undefined;
  return { pageSize: webUi?.pageSize ?? DEFAULT_WEB_UI_PAGE_SIZE };
}
