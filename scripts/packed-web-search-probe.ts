// Runs inside the packed consumer subprocess. The native transport fixture keeps
// the real plugin, registry, DNS validation, parser, and source selection in use.
const PACKED_LIGHT_FIXTURE_ORIGINS = [
  "https://nodejs.org",
  "https://www.gov.il",
  "https://www.gov.uk",
  "https://en.wikipedia.org",
  "https://he.wikipedia.org",
  "https://openai.com",
  "https://www.nasa.gov",
  "https://science.nasa.gov",
  "https://feeds.bbci.co.uk",
  "https://www.bbc.com",
  "https://www.bbc.co.uk",
  "https://bbc.com",
  "https://www.theguardian.com",
  "https://www.cbc.ca",
  "https://www.geektime.co.il",
  "https://techcrunch.com",
  "https://www.ynet.co.il",
  "https://rss.walla.co.il",
  "https://news.walla.co.il",
  "https://www.walla.co.il",
  "https://www.timesofisrael.com",
  "https://www.nature.com",
] as const;

export function createPackedWebSearchProbe(
  fixtureOrigins: readonly string[] = PACKED_LIGHT_FIXTURE_ORIGINS,
): string {
  return `
{
  const { createRequire, syncBuiltinESMExports } = await import("node:module");
  const { EventEmitter } = await import("node:events");
  const { Readable } = await import("node:stream");
  const require = createRequire(import.meta.url);
  const dns = require("node:dns/promises");
  const http = require("node:http");
  const https = require("node:https");
  const net = require("node:net");
  const allowedOrigins = new Set(${JSON.stringify(fixtureOrigins)});
  const original = {
    lookup: dns.lookup,
    httpRequest: http.request,
    httpsRequest: https.request,
    connect: net.Socket.prototype.connect,
    fetch: globalThis.fetch,
  };
  const requestUrls = [];
  const violations = [];
  const articlePath = "/abot-packed-light-fixture-article";
  const articleText = "Node.js release packed web fixture evidence";

  function assertFixtureOrigin(url) {
    if (allowedOrigins.has(url.origin)) return;
    violations.push(url.origin);
    throw new Error("packed Light attempted an unexpected origin: " + url.origin);
  }

  function fixtureDocument(url) {
    if (url.pathname === "/robots.txt") {
      return { type: "text/plain", body: "User-agent: *\\nAllow: /\\n" };
    }
    if (url.pathname === articlePath) {
      return {
        type: "text/html; charset=utf-8",
        body: "<!doctype html><title>" + articleText + "</title><main><p>" +
          articleText + ". This public fixture verifies discovery from an empty cache.</p></main>",
      };
    }
    if (url.pathname.includes("sitemap")) {
      return {
        type: "application/xml",
        body: '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>' +
          url.origin + articlePath + '</loc></url></urlset>',
      };
    }
    if (/rss|feed|\\.xml$/u.test(url.pathname)) {
      return {
        type: "application/rss+xml",
        body: '<rss version="2.0"><channel><title>Fixture updates</title><item><title>' +
          articleText + '</title><link>' + url.origin + articlePath +
          '</link><description>Public release evidence.</description></item></channel></rss>',
      };
    }
    return {
      type: "text/html; charset=utf-8",
      body: '<!doctype html><title>Fixture source</title><main><a href="' +
        articlePath + '">' + articleText + '</a></main>',
    };
  }

  function fixtureRequest(options, callback) {
    const url = new URL(options.protocol + "//" + options.hostname + options.path);
    assertFixtureOrigin(url);
    requestUrls.push(url.href);
    const request = new EventEmitter();
    request.end = () => {
      queueMicrotask(() => {
        const document = fixtureDocument(url);
        const response = Readable.from([Buffer.from(document.body)]);
        response.statusCode = 200;
        response.headers = { "content-type": document.type };
        response.once("end", () => request.emit("close"));
        response.once("close", () => request.emit("close"));
        callback(response);
      });
      return request;
    };
    request.destroy = (error) => {
      if (error) request.emit("error", error);
      request.emit("close");
      return request;
    };
    return request;
  }

  function assertLightMetadata(result) {
    if (result.ok !== true) {
      throw new Error("packed Light failed: " + JSON.stringify(result));
    }
    const light = result.data?.eventMeta?.lightSearch;
    if (light?.provider !== "light") {
      throw new Error("packed no-key search did not select Light");
    }
    if (light.scope !== "configured_sources") {
      throw new Error("packed Light omitted its source coverage boundary");
    }
    if (light.kind !== "web_search_scope") {
      throw new Error("packed Light returned the wrong metadata kind");
    }
    if (light.version !== 1) {
      throw new Error("packed Light returned an unsupported metadata version");
    }
    const stopReasons = new Set([
      "completed", "time_budget", "request_budget", "byte_budget", "candidate_budget",
    ]);
    if (!stopReasons.has(light.stopReason)) {
      throw new Error("packed Light omitted its bounded stop reason");
    }
    for (const name of ["selectedSources", "consultedSources"]) {
      if (!Array.isArray(light[name])) {
        throw new Error("packed Light omitted its " + name + " IDs");
      }
      for (const id of light[name]) {
        if (typeof id !== "string") {
          throw new Error("packed Light returned an invalid source ID");
        }
        if (id.length === 0) {
          throw new Error("packed Light returned an empty source ID");
        }
      }
    }
    for (const id of light.consultedSources) {
      if (!light.selectedSources.includes(id)) {
        throw new Error("packed Light consulted an unselected source");
      }
    }
    if (!Array.isArray(light.sources)) {
      throw new Error("packed Light omitted result provenance");
    }
    for (const source of light.sources) {
      assertFixtureOrigin(new URL(source.url));
      if (!["fetched", "fresh_cache"].includes(source.cacheState)) {
        throw new Error("packed Light omitted the source cache state");
      }
      for (const name of ["fetchedAt", "publishedAt", "updatedAt"]) {
        if (source[name] === undefined && name !== "fetchedAt") continue;
        if (typeof source[name] !== "string") {
          throw new Error("packed Light omitted a source timestamp");
        }
        if (new Date(source[name]).toISOString() !== source[name]) {
          throw new Error("packed Light returned a non-ISO source timestamp");
        }
      }
    }
    const resultUrls = result.data?.eventMeta?.urls ?? [];
    for (const url of resultUrls) {
      if (!light.sources.some((source) => source.url === url)) {
        throw new Error("packed Light returned a result without source provenance");
      }
    }
    return light;
  }

  try {
    dns.lookup = async (hostname) => {
      assertFixtureOrigin(new URL("https://" + hostname));
      return [{ address: [93, 184, 216, 34].join("."), family: 4 }];
    };
    http.request = fixtureRequest;
    https.request = fixtureRequest;
    net.Socket.prototype.connect = () => {
      violations.push("socket");
      throw new Error("packed Light must not open a network socket");
    };
    globalThis.fetch = async () => {
      violations.push("fetch");
      throw new Error("packed Light bypassed the public HTTP transport");
    };
    syncBuiltinESMExports();

    const search = await toolRegistry.execute({
      tool: "web_search",
      params: { query: "Node.js release packed web fixture" },
    });
    assertLightMetadata(search);
    const discoveredUrls = search.data?.eventMeta?.urls ?? [];
    if (!discoveredUrls.some((url) => new URL(url).pathname === articlePath)) {
      throw new Error("packed Light did not discover the fixture article from its bundled catalog");
    }
    if (search.producedNewInformation !== true) {
      throw new Error("packed Light did not mark discovered information");
    }
    if (!requestUrls.some((url) => new URL(url).pathname === "/robots.txt")) {
      throw new Error("packed Light skipped robots policy");
    }
    if (!requestUrls.some((url) => new URL(url).pathname === articlePath)) {
      throw new Error("packed Light returned an unfetched discovery candidate");
    }

    const noMatches = await toolRegistry.execute({
      tool: "web_search",
      params: { query: "qzvjkflpnmwx unrelatedmissingterm" },
    });
    assertLightMetadata(noMatches);
    if (noMatches.producedNewInformation !== false) {
      throw new Error("packed empty Light search claimed new information");
    }
    if (noMatches.data?.hasData !== false) {
      throw new Error("packed empty Light search claimed source matches");
    }

    const fetched = await toolRegistry.execute({
      tool: "web_fetch",
      params: { url: discoveredUrls[0] },
    });
    if (fetched.ok !== true) {
      throw new Error("packed web_fetch regressed without a Brave key");
    }
    if (violations.length > 0) {
      throw new Error("packed Light attempted external network work: " + violations.join(","));
    }
  } finally {
    dns.lookup = original.lookup;
    http.request = original.httpRequest;
    https.request = original.httpsRequest;
    net.Socket.prototype.connect = original.connect;
    globalThis.fetch = original.fetch;
    syncBuiltinESMExports();
  }
}
`;
}
