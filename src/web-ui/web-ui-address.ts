const DEFAULT_WEB_HOST = "127.0.0.1";
const DEFAULT_WEB_PORT = 5177;

export type WebUiAddress = Readonly<{
  listenHost: string;
  port: number;
  browserUrl: string;
  healthUrl: string;
}>;

function resolvePort(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65_535
    ? parsed
    : DEFAULT_WEB_PORT;
}

function resolveBrowserHost(listenHost: string): string {
  const normalized = listenHost.trim().toLowerCase();
  if (
    normalized === "0.0.0.0" ||
    normalized === "::" ||
    normalized === "[::]" ||
    normalized === "*"
  ) {
    return DEFAULT_WEB_HOST;
  }
  if (listenHost.includes(":") && !listenHost.startsWith("[")) {
    return `[${listenHost}]`;
  }
  return listenHost;
}

export function resolveWebUiAddress(
  env: NodeJS.ProcessEnv = process.env,
): WebUiAddress {
  const listenHost = env.LLM_RUNTIME_WEB_HOST?.trim() || DEFAULT_WEB_HOST;
  const port = resolvePort(env.LLM_RUNTIME_WEB_PORT);
  const browserHost = resolveBrowserHost(listenHost);
  const browserUrl = `http://${browserHost}:${port}/`;
  return {
    listenHost,
    port,
    browserUrl,
    healthUrl: new URL("web-health", browserUrl).toString(),
  };
}
