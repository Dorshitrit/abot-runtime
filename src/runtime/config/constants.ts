export const DEFAULT_RUNTIME_AGENT_BRIDGE_URL =
  "ws://127.0.0.1:8787/abot/agent-bridge";
export const DEFAULT_RUNTIME_CONFIG_FILE = "runtime.config.json";
export const DEFAULT_RUNTIME_LOGGING_ENABLED = true;
export const DEFAULT_RUNTIME_LOG_ROTATION_CONFIG = {
  maxFileSizeMb: 20,
  maxFiles: 10,
  maxAgeDays: 7,
} as const;
