import type { IncomingMessage, ServerResponse } from "node:http";
import type { SparkHomeReader } from "../../runtime/spark-home/contracts.js";
import { sendJson } from "./http.js";
import { renderSparkHomeDocument, renderSparkHomeLoadFailure, SPARK_HOME_CONTENT_POLICY } from "./spark-home-document.js";

type SparkHomeRouteRequest = Readonly<{
  method: string; route: string; environmentId: string;
  request: IncomingMessage; response: ServerResponse;
}>;

function readRequestedScreenRevision(url: URL): number | null {
  const raw = url.searchParams.get("revision") ?? "";
  if (!/^[1-9]\d*$/.test(raw)) return null;
  const revision = Number(raw);
  if (!Number.isSafeInteger(revision)) return null;
  return revision;
}

function sendSparkHomeDocument(response: ServerResponse, status: number, html: string): void {
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": SPARK_HOME_CONTENT_POLICY,
    "connection-allowlist": "()",
    "referrer-policy": "no-referrer",
    "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  });
  response.end(html);
}

/** Read-only Web projection. The HOME generation owner alone replaces a screen. */
export class SparkHomeRoutes {
  constructor(private readonly reader: (environmentId: string) => SparkHomeReader | undefined) {}

  async handle(input: SparkHomeRouteRequest): Promise<boolean> {
    if (!["runtime/spark-home", "runtime/spark-home/content"].includes(input.route)) return false;
    const { response } = input;
    response.setHeader("cache-control", "private, no-store");
    response.setHeader("x-content-type-options", "nosniff");
    if (input.method !== "GET") {
      response.setHeader("allow", "GET");
      sendJson(response, 405, { ok: false, error: "method_not_allowed" });
      return true;
    }
    const content = input.route.endsWith("/content");
    const url = new URL(input.request.url ?? "/", "http://localhost");
    const revision = content ? readRequestedScreenRevision(url) : null;
    if (content && revision === null) {
      sendSparkHomeDocument(response, 400, renderSparkHomeLoadFailure(revision));
      return true;
    }
    try {
      const reader = this.reader(input.environmentId);
      if (!reader) throw new Error("spark_home_unavailable");
      const snapshot = await reader.read();
      if (!content) {
        sendJson(response, 200, {
          ok: true,
          screen: snapshot.html === null ? null : {
            revision: snapshot.revision, updatedAt: snapshot.updatedAt,
          },
        });
        return true;
      }
      if (snapshot.html === null) {
        sendSparkHomeDocument(response, 404, renderSparkHomeLoadFailure(revision));
        return true;
      }
      if (revision !== snapshot.revision) {
        sendSparkHomeDocument(response, 409, renderSparkHomeLoadFailure(revision));
        return true;
      }
      sendSparkHomeDocument(response, 200, renderSparkHomeDocument(snapshot.html, snapshot.revision));
      return true;
    } catch {
      if (content) {
        sendSparkHomeDocument(response, 503, renderSparkHomeLoadFailure(revision));
        return true;
      }
      sendJson(response, 503, { ok: false, error: "spark_home_unavailable" });
      return true;
    }
  }
}
