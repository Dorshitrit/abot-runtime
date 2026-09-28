import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import type {
  PassiveCollectorEvent,
  PassiveObservation,
  PassiveObservationSource,
} from "../../shared/passive-observation.js";
import { isHostRecord } from "./protocol.js";
import {
  redactObservationSource,
  redactObservationText,
} from "./observation-redaction.js";
import {
  isPassiveCollectorEvent,
  isObservationOwner,
  OBSERVATION_CONTENT_LIMIT,
  OBSERVATION_WIRE_LIMIT,
} from "./observation-protocol.js";

// Include the previous title so tabs opened before an update are also excluded.
const OWN_WEB_UI_TITLES = ["ABot Runtime — Workspace", "ABot Runtime"];
const BROWSER_WINDOW_NAMES = [
  "Mozilla Firefox",
  "Mozilla Firefox (Private Browsing)",
  "Google Chrome",
  "Chromium",
  "Microsoft Edge",
  "Brave",
  "Safari",
] as const;
const BROWSER_WINDOW_SUFFIXES = BROWSER_WINDOW_NAMES.flatMap((browser) => [
  ` — ${browser}`,
  ` - ${browser}`,
]);

function isOwnWebUiWindowTitle(title: string | undefined): boolean {
  if (typeof title !== "string") return false;
  if (OWN_WEB_UI_TITLES.includes(title)) return true;
  const suffix = BROWSER_WINDOW_SUFFIXES.find((candidate) =>
    title.endsWith(candidate),
  );
  if (!suffix) return false;
  return OWN_WEB_UI_TITLES.includes(title.slice(0, -suffix.length));
}

function hasBoundedSourceMetadata(source: PassiveObservationSource): boolean {
  if (!isObservationOwner(source.app)) return false;
  if (typeof source.windowId !== "string") return false;
  if (source.windowId.length === 0) return false;
  if (source.windowId.length > 256) return false;
  for (const field of ["documentId", "title", "url"] as const) {
    if (source[field] === undefined) continue;
    if (typeof source[field] !== "string") return false;
    if (source[field].length > 4096) return false;
  }
  return true;
}

function boundedObservation(
  observation: PassiveObservation,
): PassiveObservation {
  let bounded = observation;
  while (
    Buffer.byteLength(JSON.stringify(bounded)) >
      OBSERVATION_WIRE_LIMIT - 1024 &&
    bounded.content.length > 0
  ) {
    bounded = {
      ...bounded,
      content: bounded.content.slice(
        0,
        Math.floor(bounded.content.length * 0.75),
      ),
      coverage: "partial",
      coverageReason: "transport_content_limit",
    };
  }
  return bounded;
}

/** Bounded source-aware deduplication; returning to a source remains an activity observation. */
export class ObservationFilter {
  // Private to one collector lease: source identity must not retain or expose raw secrets.
  private readonly sourceIdentityKey = randomBytes(32);
  private sequence = 0;
  private lastStatus?: string;
  private lastSource?: string;
  private readonly fingerprints = new Map<
    string,
    { fingerprint: string; observationId: string }
  >();
  constructor(private readonly excludedApplications: readonly string[] = []) {}
  accept(value: unknown): PassiveCollectorEvent | undefined {
    if (isPassiveCollectorEvent(value) && value.type === "status") {
      if (value.state === "paused") this.lastSource = undefined;
      const reason =
        value.reason === undefined
          ? undefined
          : redactObservationText(value.reason).slice(0, 512);
      const identity = JSON.stringify([value.state, reason]);
      if (identity === this.lastStatus) return undefined;
      this.lastStatus = identity;
      return {
        type: "status",
        state: value.state,
        ...(reason === undefined ? {} : { reason }),
      };
    }
    if (
      !isHostRecord(value) ||
      value.type !== "snapshot" ||
      !isHostRecord(value.source)
    )
      return undefined;
    if (
      typeof value.beforeKey !== "string" ||
      value.beforeKey !== value.afterKey
    )
      return undefined;
    if (value.secure === true || value.locked === true) return undefined;
    if (
      typeof value.content !== "string" ||
      typeof value.source.app !== "string"
    )
      return undefined;
    const rawSource = {
      app: value.source.app,
      processId: value.source.processId,
      windowId: value.source.windowId,
      documentId: value.source.documentId,
      title: value.source.title,
      url: value.source.url,
    } as PassiveObservationSource;
    if (!hasBoundedSourceMetadata(rawSource)) return undefined;
    if (isOwnWebUiWindowTitle(rawSource.title)) {
      this.lastSource = undefined;
      return undefined;
    }
    const isExcludedApplication = this.excludedApplications.some(
      (app) => app.toLocaleLowerCase() === rawSource.app.toLocaleLowerCase(),
    );
    if (isExcludedApplication) {
      this.lastSource = undefined;
      return undefined;
    }
    const sourceKey = createHmac("sha256", this.sourceIdentityKey)
      .update(
        JSON.stringify([
          rawSource.app,
          rawSource.processId,
          rawSource.windowId,
          rawSource.documentId,
          rawSource.title,
          rawSource.url,
        ]),
      )
      .digest("hex");
    const source = redactObservationSource(rawSource, sourceKey);
    const content = redactObservationText(value.content)
      .replace(/\r\n?/gu, "\n")
      .replace(/[ \t]+\n/gu, "\n")
      .trim();
    const fingerprint = createHash("sha256").update(content).digest("hex");
    const previous = this.fingerprints.get(sourceKey);
    const duplicate = previous?.fingerprint === fingerprint;
    if (duplicate && this.lastSource === sourceKey) return undefined;
    const truncated = content.length > OBSERVATION_CONTENT_LIMIT;
    let coverageReason =
      typeof value.coverageReason === "string"
        ? redactObservationText(value.coverageReason).slice(0, 512)
        : undefined;
    if (truncated) coverageReason = "content_limit";
    const observation: PassiveObservation = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      sequence: this.sequence + 1,
      source,
      content: duplicate ? "" : content.slice(0, OBSERVATION_CONTENT_LIMIT),
      ...(duplicate ? { revisitsObservationId: previous.observationId } : {}),
      kind: duplicate ? "activity" : value.kind === "edit" ? "edit" : "view",
      extraction: value.extraction as PassiveObservation["extraction"],
      coverage: truncated
        ? "partial"
        : (value.coverage as PassiveObservation["coverage"]),
      coverageReason,
    };
    const event = {
      type: "observation" as const,
      observation: boundedObservation(observation),
    };
    if (!isPassiveCollectorEvent(event)) return undefined;
    this.sequence += 1;
    this.lastSource = sourceKey;
    this.fingerprints.delete(sourceKey);
    this.fingerprints.set(sourceKey, {
      fingerprint,
      observationId: duplicate ? previous.observationId : observation.id,
    });
    if (this.fingerprints.size > 128)
      this.fingerprints.delete(this.fingerprints.keys().next().value!);
    return event;
  }
}
