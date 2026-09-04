import { parseWebSourceUrl } from "./source-url-policy.js";

const MAX_SOURCES_PER_RECEIPT = 25;
const RETRIEVAL_STATES = new Set(["not_attempted", "retrieved", "failed"]);
const PRESENTATION_STATES = new Set([
  "omitted",
  "reference",
  "snippet",
  "content",
]);

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
}

function operationForTool(toolName) {
  if (toolName === "web_search") return "search";
  if (toolName === "web_fetch") return "fetch";
  return "";
}

function sourceTitle(value, hostname) {
  if (typeof value !== "string" || !value.trim()) return hostname;
  return value.trim().slice(0, 256);
}

function normalizeSource(value, legacy = false) {
  const source = record(value);
  if (!source) return null;
  const url = parseWebSourceUrl(source.url);
  if (!url || !RETRIEVAL_STATES.has(source.retrieval)) return null;
  const hasKnownPresentation = PRESENTATION_STATES.has(source.presentation);
  const hasLegacyPresentation = legacy && source.presentation === "unknown";
  if (!hasKnownPresentation && !hasLegacyPresentation) return null;
  const hasUnretrievedContent =
    source.presentation === "content" && source.retrieval !== "retrieved";
  if (hasUnretrievedContent) return null;
  if (typeof source.contentTruncated !== "boolean") return null;
  const requestedUrl = parseWebSourceUrl(source.requestedUrl);
  return {
    url: url.href,
    ...(requestedUrl ? { requestedUrl: requestedUrl.href } : {}),
    title: sourceTitle(source.title, url.hostname),
    retrieval: source.retrieval,
    presentation: source.presentation,
    contentTruncated: source.contentTruncated,
  };
}

function normalizeReceipt(value, toolName, legacy = false) {
  const receipt = record(value);
  const operation = operationForTool(toolName);
  if (!receipt || !operation || receipt.operation !== operation) return null;
  if (receipt.version !== (legacy ? 0 : 1)) return null;
  if (!Array.isArray(receipt.sources)) return null;
  if (receipt.sources.length > MAX_SOURCES_PER_RECEIPT) return null;
  const omittedSourceCount = legacy ? 0 : receipt.omittedSourceCount;
  const hasOmittedSourceCount =
    !legacy && Object.hasOwn(receipt, "omittedSourceCount");
  if (hasOmittedSourceCount && !Number.isSafeInteger(omittedSourceCount))
    return null;
  if (hasOmittedSourceCount && omittedSourceCount < 0) return null;
  if (
    hasOmittedSourceCount &&
    receipt.sources.length + omittedSourceCount > MAX_SOURCES_PER_RECEIPT
  )
    return null;
  const sources = receipt.sources
    .map((source) => normalizeSource(source, legacy))
    .filter(Boolean);
  const provider = ["brave", "light"].includes(receipt.provider)
    ? receipt.provider
    : undefined;
  return {
    version: receipt.version,
    operation,
    ...(provider ? { provider } : {}),
    ...(omittedSourceCount > 0 ? { omittedSourceCount } : {}),
    sources,
  };
}

export function normalizeWebSources(value, toolName) {
  return normalizeReceipt(value, toolName);
}

function normalizedUrlSet(values) {
  if (!Array.isArray(values)) return new Set();
  return new Set(
    values
      .slice(0, MAX_SOURCES_PER_RECEIPT)
      .map((value) => parseWebSourceUrl(value)?.href)
      .filter(Boolean),
  );
}

export function normalizeLegacyWebSources(value, toolName) {
  const meta = record(value);
  const operation = operationForTool(toolName);
  if (!meta || !operation || !Array.isArray(meta.urls)) return null;
  if (meta.urls.length > MAX_SOURCES_PER_RECEIPT) return null;
  const fetched = normalizedUrlSet(meta.fetchedUrls);
  const partial = normalizedUrlSet(meta.partialFetchedUrls);
  const sources = meta.urls.flatMap((value) => {
    const url = parseWebSourceUrl(value);
    if (!url) return [];
    const wasFetched =
      operation === "fetch" || fetched.has(url.href) || partial.has(url.href);
    return [
      {
        url: url.href,
        title: url.hostname,
        retrieval: wasFetched ? "retrieved" : "not_attempted",
        presentation: "unknown",
        contentTruncated: false,
      },
    ];
  });
  return {
    version: 0,
    operation,
    ...(record(meta.lightSearch)?.provider === "light"
      ? { provider: "light" }
      : {}),
    sources,
  };
}

function eventReceipt(event) {
  const toolName = event.tool;
  if (event.webSources?.version === 0) {
    return normalizeReceipt(event.webSources, toolName, true);
  }
  return normalizeWebSources(event.webSources, toolName);
}

function replayIdentity(event) {
  const requestId = typeof event.requestId === "string" ? event.requestId : "";
  const callId = typeof event.callId === "string" ? event.callId : "";
  const originalSequence = event.eventSequence;
  if (Number.isSafeInteger(originalSequence) && originalSequence > 0) {
    return `${requestId}|${callId}|event:${originalSequence}`;
  }
  const transportSequence = event.seqNo ?? event.lastSeqNo;
  if (Number.isSafeInteger(transportSequence) && transportSequence > 0) {
    return `${requestId}|${callId}|transport:${transportSequence}`;
  }
  return callId ? `${requestId}|${callId}` : "";
}

export function buildConversationSources(events = []) {
  if (!Array.isArray(events)) return [];
  const groups = [];
  const seen = new Set();
  for (const value of events) {
    const event = record(value);
    if (!event || (event.eventName || event.name) !== "tool.completed")
      continue;
    const receipt = eventReceipt(event);
    if (!receipt) continue;
    const hasSourceEvidence =
      receipt.sources.length > 0 || receipt.omittedSourceCount > 0;
    if (!hasSourceEvidence) continue;
    const identity = replayIdentity(event);
    const replayKey = identity ? `${identity}|${JSON.stringify(receipt)}` : "";
    if (replayKey && seen.has(replayKey)) continue;
    if (replayKey) seen.add(replayKey);
    groups.push({
      ...receipt,
      id: identity || `source-call-${groups.length + 1}`,
      callId: typeof event.callId === "string" ? event.callId : "",
    });
  }
  return groups;
}
