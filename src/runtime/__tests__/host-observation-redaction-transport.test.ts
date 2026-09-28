import type { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, expect, test, vi } from "vitest";
import { observationRedactionTransportCases } from "./support/host-observation-redaction-transport-cases.js";
import { NativeObservationSession } from "../../computer-access/companion/native-observations.js";
import { ObservationFilter } from "../../computer-access/companion/observation-filter.js";
import { startDesktopCollector } from "../../computer-access/companion/observation-process.js";
import {
  isPassiveCollectorEvent,
  OBSERVATION_CONTENT_LIMIT,
} from "../../computer-access/companion/observation-protocol.js";
import type {
  PassiveCollectorEvent,
  PassiveObservation,
} from "../../shared/passive-observation.js";
import {
  documentIdentity,
  ObservationQueue,
} from "../passive-learning/queue.js";

// The collector's macOS prerequisite check must not invoke a native executable.
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFileSync: vi.fn(() => process.cwd()),
}));

const sessions: NativeObservationSession[] = [];
const REDACTED = "[REDACTED]";
afterEach(() => {
  for (const session of sessions.splice(0)) session.close();
});

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    type: "snapshot",
    source: {
      app: "Editor",
      processId: 10,
      windowId: "11",
      documentId: "draft-1",
      title: "Working notes",
      url: "https://example.test/notes",
    },
    content: "Keep this project note.",
    kind: "edit",
    extraction: "uia",
    coverage: "partial",
    coverageReason: "visible_accessibility_subset",
    beforeKey: "stable-document",
    afterKey: "stable-document",
    ...overrides,
  };
}

function observationFrom(
  event: PassiveCollectorEvent | undefined,
): PassiveObservation {
  expect(event?.type).toBe("observation");
  if (event?.type !== "observation")
    throw new Error("Expected an observation event");
  return event.observation;
}

function expectSecretsAbsent(value: unknown, secrets: readonly string[]) {
  const serialized = JSON.stringify(value);
  for (const secret of secrets) expect(serialized).not.toContain(secret);
}

function transportHarness(platform: string) {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
  });
  // No PID: closing the fake collector can never signal an operating-system process.
  const spawnProcess = vi
    .fn<typeof spawn>()
    .mockReturnValue(child as unknown as ReturnType<typeof spawn>);
  const payloads: unknown[] = [];
  const events: PassiveCollectorEvent[] = [];
  const session = new NativeObservationSession(
    (message) => {
      payloads.push(message);
      events.push((message as { event: PassiveCollectorEvent }).event);
    },
    (options) =>
      startDesktopCollector({
        ...options,
        platform,
        spawnProcess: spawnProcess as unknown as typeof spawn,
      }),
  );
  sessions.push(session);
  session.receive({
    type: "observe_start",
    ownerId: "test-owner",
    leaseId: randomUUID(),
  });
  return { child, spawnProcess, payloads, events };
}

test.each([
  { platform: "win32", extraction: "uia", command: "powershell.exe" },
  { platform: "darwin", extraction: "ax", command: "/usr/bin/swift" },
  { platform: "linux", extraction: "atspi", command: "python3" },
])(
  "$platform synthetic collector output is redacted before the session sends it",
  ({ platform, extraction, command }) => {
    const harness = transportHarness(platform);
    const secrets = [
      "app-secret-2026",
      "window-secret-2026",
      "document-secret-2026",
      "title-secret-2026",
      "url-secret-2026",
      "content-secret-2026",
      "coverage-secret-2026",
      "status-secret-2026",
      "unexpected-status-secret-2026",
      "stability-secret-2026",
    ];
    const input = snapshot({
      source: {
        app: `Editor api_key=${secrets[0]}`,
        processId: 10,
        windowId: `window password=${secrets[1]}`,
        documentId: `file:///draft?api_key=${secrets[2]}`,
        title: `Working notes password=${secrets[3]}`,
        url: `https://example.test/view?access_token=${secrets[4]}&tab=notes`,
        unexpected: secrets[8],
      },
      content: `Keep this project note.\npassword=${secrets[5]}\nSafe next line.`,
      coverageReason: `visible subset; api_key=${secrets[6]}`,
      beforeKey: secrets[9],
      afterKey: secrets[9],
      extraction,
    });
    const status = {
      type: "status",
      state: "partial",
      reason: `collector partial; password=${secrets[7]}`,
      unexpected: secrets[8],
    };
    const wire = Buffer.from(
      `${JSON.stringify(input)}\n${JSON.stringify(status)}\n`,
    );
    const split = Math.floor(wire.length / 2);
    harness.child.stdout.write(wire.subarray(0, split));
    harness.child.stdout.write(wire.subarray(split));

    expect(harness.spawnProcess).toHaveBeenCalledOnce();
    expect(harness.spawnProcess.mock.calls[0]?.[0]).toBe(command);
    expect(harness.events).toHaveLength(3);
    for (const payload of harness.payloads)
      expectSecretsAbsent(payload, secrets);
    const observation = observationFrom(harness.events[1]);
    expect(observation.content).toBe(REDACTED);
    expect(observation.extraction).toBe(extraction);
    expect(observation.source).toMatchObject({
      app: REDACTED,
      windowId: REDACTED,
      title: REDACTED,
      url: REDACTED,
      processId: 10,
    });
    expect(observation.source.documentId).toMatch(/^redacted-source:/u);
    expect(observation.source).not.toHaveProperty("unexpected");
    expect(observation.coverageReason).toBe(REDACTED);
    expect(harness.events[2]).toEqual({
      type: "status",
      state: "partial",
      reason: REDACTED,
    });
  },
);

test.each(observationRedactionTransportCases)(
  "a recognized indicator masks the whole outgoing text field: %s",
  (input) => {
    const harness = transportHarness("linux");
    const raw = snapshot({
      content: input,
      source: { ...snapshot().source, title: input },
      coverageReason: input,
      extraction: "atspi",
    });
    harness.child.stdout.write(`${JSON.stringify(raw)}\n`);
    harness.child.stdout.write(
      `${JSON.stringify({ type: "status", state: "partial", reason: input })}\n`,
    );

    expect(harness.events).toHaveLength(3);
    expectSecretsAbsent(harness.payloads, ["transport-secret"]);
    const observation = observationFrom(harness.events[1]);
    expect(observation.content).toBe(REDACTED);
    expect(observation.source.title).toBe(REDACTED);
    expect(observation.coverageReason).toBe(REDACTED);
    expect(harness.events[2]).toEqual({
      type: "status",
      state: "partial",
      reason: REDACTED,
    });
  },
);

test.each(["Arbitrary Notes", "Sheet Workshop", "Research Browser"])(
  "safe fields from %s keep normalization and deduplication",
  (app) => {
    const filter = new ObservationFilter();
    const input = snapshot({
      source: { ...snapshot().source, app },
      content: "  Keep this project note. \r\nSafe next line.  ",
    });
    const first = observationFrom(filter.accept(input));
    expect(first.source).toEqual(input.source);
    expect(first.content).toBe("Keep this project note.\nSafe next line.");
    expect(first.coverageReason).toBe("visible_accessibility_subset");
    expect(first.kind).toBe("edit");
    expect(first.sequence).toBe(1);
    expect(filter.accept(input)).toBeUndefined();
    const masked = observationFrom(
      filter.accept({ ...input, content: "password=synthetic-secret" }),
    );
    expect(masked.content).toBe(REDACTED);
    expect(masked.source).toEqual(input.source);
  },
);

test("edits within a masked field deduplicate, and a later safe field emits", () => {
  const filter = new ObservationFilter();
  const first = observationFrom(
    filter.accept(snapshot({ content: "Notes\npassword=first-secret-2026" })),
  );
  expect(first.content).toBe(REDACTED);
  expect(
    filter.accept(snapshot({ content: "Notes\npassword=first-secret-2026" })),
  ).toBeUndefined();
  expect(
    filter.accept(snapshot({ content: "Notes\npassword=second-secret-2026" })),
  ).toBeUndefined();
  expect(
    filter.accept(
      snapshot({ content: "Revised notes\npassword=second-secret-2026" }),
    ),
  ).toBeUndefined();
  const changed = observationFrom(
    filter.accept(snapshot({ content: "Revised safe notes" })),
  );
  expect(changed.content).toBe("Revised safe notes");
  expect(changed.sequence).toBe(2);
});

test.each(["app", "windowId", "documentId", "title", "url"])(
  "masking source %s preserves distinct documents and the original revisit binding",
  (field) => {
    const filter = new ObservationFilter();
    const source = snapshot().source;
    const inputA = snapshot({
      source: { ...source, [field]: "password=source-secret-a" },
    });
    const inputB = snapshot({
      source: { ...source, [field]: "password=source-secret-b" },
    });
    const first = observationFrom(filter.accept(inputA));
    const second = observationFrom(filter.accept(inputB));
    const returnToFirst = observationFrom(filter.accept(inputA));
    expect(first.source.documentId).toBeTruthy();
    expect(second.source.documentId).not.toBe(first.source.documentId);
    expect(returnToFirst.source).toEqual(first.source);
    expect(returnToFirst.revisitsObservationId).toBe(first.id);
    expect(returnToFirst.kind).toBe("activity");
    expect(returnToFirst.content).toBe("");
    expect(second.content).toBe("Keep this project note.");
    expect(second.revisitsObservationId).toBeUndefined();
    expect(filter.accept(inputA)).toBeUndefined();
    expectSecretsAbsent(
      [first, second, returnToFirst],
      ["source-secret-a", "source-secret-b"],
    );

    const queue = new ObservationQueue();
    const firstLearning = { ...first, deviceId: "test-device" };
    const secondLearning = { ...second, deviceId: "test-device" };
    expect(documentIdentity(firstLearning)).not.toBe(
      documentIdentity(secondLearning),
    );
    expect(queue.add(firstLearning, Date.now())).toBe(true);
    expect(queue.add(secondLearning, Date.now())).toBe(true);
    expect(queue.items.map(({ id }) => id)).toEqual([first.id, second.id]);
  },
);

test("masked source identities are stable within a collector and private across collectors", () => {
  const input = snapshot({
    source: { ...snapshot().source, title: "password=source-secret-2026" },
  });
  const first = observationFrom(new ObservationFilter().accept(input));
  const second = observationFrom(new ObservationFilter().accept(input));
  expect(first.source.documentId).not.toBe(second.source.documentId);
});

test("the filter retains no raw secrets in source keys or status deduplication state", () => {
  const filter = new ObservationFilter();
  const sourceSecret = "retained-source-secret-2026";
  const statusSecret = "retained-status-secret-2026";
  observationFrom(
    filter.accept(
      snapshot({
        source: { ...snapshot().source, title: `password=${sourceSecret}` },
      }),
    ),
  );
  filter.accept({
    type: "status",
    state: "partial",
    reason: `password=${statusSecret}`,
  });
  const retained = filter as unknown as {
    fingerprints: Map<string, unknown>;
    lastSource?: string;
    lastStatus?: string;
  };
  expect(retained.fingerprints.size).toBe(1);
  expectSecretsAbsent(
    {
      ...filter,
      fingerprints: [...retained.fingerprints],
      lastSource: retained.lastSource,
      lastStatus: retained.lastStatus,
    },
    [sourceSecret, statusSecret],
  );
});

test("redaction scans the whole field before content truncation", () => {
  const prefix = `${"A".repeat(OBSERVATION_CONTENT_LIMIT + 25)}\npassword=`;
  const event = new ObservationFilter().accept(
    snapshot({
      content: `${prefix}boundary-secret-that-crosses-the-content-limit`,
    }),
  );
  const observation = observationFrom(event);
  expect(observation.content).toBe(REDACTED);
  expect(observation.coverageReason).toBe("visible_accessibility_subset");
  expect(isPassiveCollectorEvent(event)).toBe(true);
});

test("masking fields with indicators near their input limits stays within wire limits", () => {
  const filter = new ObservationFilter();
  const label = " password=x";
  const event = filter.accept(
    snapshot({
      source: {
        ...snapshot().source,
        app: "A".repeat(128 - label.length) + label,
        windowId: "W".repeat(256 - label.length) + label,
        title: "T".repeat(4096 - label.length) + label,
      },
    }),
  );
  const observation = observationFrom(event);
  expect(isPassiveCollectorEvent(event)).toBe(true);
  expect(observation.source.documentId).toMatch(/^redacted-source:/u);
  expect(observation.source.app).toBe(REDACTED);
  expect(observation.source.windowId).toBe(REDACTED);
  expect(observation.source.title).toBe(REDACTED);
  const status = filter.accept({
    type: "status",
    state: "failed",
    reason: "R".repeat(512 - label.length) + label,
  });
  expect(status).toEqual({ type: "status", state: "failed", reason: REDACTED });
  expect(isPassiveCollectorEvent(status)).toBe(true);
});

test("safe content still uses the existing truncation limit", () => {
  const content = "A".repeat(OBSERVATION_CONTENT_LIMIT + 20);
  const event = new ObservationFilter().accept(snapshot({ content }));
  expect(observationFrom(event).content).toBe(
    content.slice(0, OBSERVATION_CONTENT_LIMIT),
  );
  expect(observationFrom(event).coverageReason).toBe("content_limit");
  expect(isPassiveCollectorEvent(event)).toBe(true);
});

test("status deduplication uses the masked reason and preserves state changes", () => {
  const filter = new ObservationFilter();
  expect(
    filter.accept({
      type: "status",
      state: "partial",
      reason: "password=first-secret",
    }),
  ).toEqual({ type: "status", state: "partial", reason: REDACTED });
  expect(
    filter.accept({
      type: "status",
      state: "partial",
      reason: "Changed text password=second-secret",
    }),
  ).toBeUndefined();
  expect(
    filter.accept({
      type: "status",
      state: "failed",
      reason: "password=second-secret",
    }),
  ).toEqual({ type: "status", state: "failed", reason: REDACTED });
});

test("redaction does not turn malformed source metadata into an accepted observation", () => {
  expect(
    new ObservationFilter().accept(
      snapshot({
        source: {
          ...snapshot().source,
          documentId: { secret: "invalid-source" },
          title: "password=valid-secret",
        },
      }),
    ),
  ).toBeUndefined();
});
