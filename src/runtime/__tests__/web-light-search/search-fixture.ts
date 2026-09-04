import type { IncomingHttpHeaders } from "node:http";
import type { RuntimePluginLoadContext } from "../../../plugin-sdk/index.js";
import type { LightSource } from "../../../../plugins/web/source/light/sources/source-definition.js";
import type {
  PublicHttpClient,
  PublicHttpRequest,
  PublicHttpResponse,
} from "../../../../plugins/web/source/public-http.js";

export function fixtureSource(id: string, keyword: string): LightSource {
  const origin = `https://${id}.example`;
  return {
    id,
    title: `${id} publisher`,
    description: `Independent ${keyword} publisher`,
    keywords: [keyword],
    languages: ["en"],
    entryUrls: [`${origin}/feed.xml`],
    allowedOrigins: [origin],
  };
}

export function fixtureResponse(
  url: string,
  body: string,
  options: {
    contentType?: string;
    status?: number;
    headers?: IncomingHttpHeaders;
  } = {},
): PublicHttpResponse {
  const bytes = Buffer.from(body);
  return {
    requestedUrl: url,
    finalUrl: url,
    status: options.status ?? 200,
    headers: {
      "content-type": options.contentType ?? "text/html",
      ...options.headers,
    },
    body: bytes,
    bytesRead: bytes.length,
    partialContent: false,
  };
}

export function article(title: string, text = title): string {
  return `<title>${title}</title><main>${text}</main>`;
}

export function feed(items: readonly { title: string; url: string }[]): string {
  return `<rss><channel><title>Publisher feed</title>${items
    .map(
      (item) =>
        `<item><title>${item.title}</title><link>${item.url}</link></item>`,
    )
    .join("")}</channel></rss>`;
}

export function fixtureHttp(
  handle: (
    request: PublicHttpRequest,
  ) => Promise<PublicHttpResponse> | PublicHttpResponse,
) {
  const requests: PublicHttpRequest[] = [];
  const httpClient: PublicHttpClient = {
    async get(request) {
      requests.push(request);
      if (new URL(request.url).pathname === "/robots.txt") {
        return fixtureResponse(request.url, "User-agent: *\nAllow: /\n", {
          contentType: "text/plain",
        });
      }
      return await handle(request);
    },
  };
  return { httpClient, requests };
}

export function fixtureContext(light: unknown): RuntimePluginLoadContext {
  return {
    id: "web",
    path: "/plugins/web/src/index.cjs",
    stateDir: "/state/web",
    rootDir: "/runtime",
    runtimeId: "fixture-runtime",
    agentBridgeUrl: "ws://fixture.example/bridge",
    runtimePaths: {
      rootDir: "/runtime",
      runtimeDir: "/runtime/.runtime",
      agentWorkDir: "/runtime/work",
      sessionsDir: "/runtime/sessions",
      attachmentsDir: "/runtime/attachments",
      workspaceDir: "/runtime/workspace",
      sharedDir: "/runtime/shared",
      compiledDir: "/runtime/compiled",
      traceFile: "/runtime/trace.jsonl",
    },
    runtimePathResolver: {} as RuntimePluginLoadContext["runtimePathResolver"],
    config: { retryBaseMs: 0, light },
    secrets: { get: () => undefined },
  };
}
