import { textOf } from "../../lib/text-format.js";

const PROVIDERS = new Set(["ollama", "openai"]);
const SAFE_MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_@+.:/=-]*$/;
const SAFE_ORIGIN_HOST_PATTERN =
  /^(?:\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9._-]+)(?::[0-9]+)?$/;
export const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434";

export function normalizeProvider(value) {
  const provider = textOf(value).trim().toLowerCase();
  return PROVIDERS.has(provider) ? provider : "";
}

export function validateRuntimeSetupModelId(value) {
  const modelId = textOf(value);
  if (!modelId.trim()) {
    return { valid: false, value: "", message: "Enter a model ID." };
  }
  if (modelId.startsWith("--")) {
    return {
      valid: false,
      value: "",
      message: "Model ID cannot start with --.",
    };
  }
  if (!SAFE_MODEL_ID_PATTERN.test(modelId)) {
    return {
      valid: false,
      value: "",
      message:
        "Start with a letter or number. After that, use only letters, numbers, and _ @ + . : / = -.",
    };
  }
  return { valid: true, value: modelId, message: "" };
}

function baseUrlIsPlainHttpOrigin(parsed) {
  if (!["http:", "https:"].includes(parsed.protocol)) return false;
  if (!SAFE_ORIGIN_HOST_PATTERN.test(parsed.host)) return false;
  if (parsed.username || parsed.password) return false;
  if (parsed.search || parsed.hash) return false;
  return parsed.pathname === "" || parsed.pathname === "/";
}

export function validateRuntimeSetupBaseUrl(value) {
  const raw = textOf(value).trim();
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return {
      valid: false,
      value: "",
      message: "Enter an HTTP or HTTPS origin without a path.",
    };
  }
  if (!baseUrlIsPlainHttpOrigin(parsed)) {
    return {
      valid: false,
      value: "",
      message: "Enter an HTTP or HTTPS origin without a path.",
    };
  }
  return {
    valid: true,
    value: `${parsed.protocol}//${parsed.host}`,
    message: "",
  };
}
