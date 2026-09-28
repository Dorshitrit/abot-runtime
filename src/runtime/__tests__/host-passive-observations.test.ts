import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, expect, test, vi } from "vitest";
import WebSocket from "ws";
import { ObservationFilter } from "../../computer-access/companion/observation-filter.js";
import { NativeObservationSession } from "../../computer-access/companion/native-observations.js";
import { HostObservationConnection } from "../../computer-access/companion/observation-connection.js";
import {
  OBSERVATION_CONTENT_LIMIT,
  OBSERVATION_LEASE_MS,
} from "../../computer-access/companion/observation-protocol.js";
import {
  renderNativeAutostart,
  nativeAutostartFile,
} from "../../computer-access/companion/autostart.js";
import { desktopCollectorCommand } from "../../computer-access/companion/observation-process.js";
import type { PassiveCollectorEvent } from "../../shared/passive-observation.js";

afterEach(() => vi.useRealTimers());
function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    type: "snapshot",
    source: {
      app: "Editor",
      processId: 10,
      windowId: "11",
      documentId: "doc1",
    },
    content: "A draft",
    kind: "edit",
    extraction: "uia",
    coverage: "partial",
    coverageReason: "visible_accessibility_subset",
    beforeKey: "doc1",
    afterKey: "doc1",
    ...overrides,
  };
}
test("drops unchanged reads, preserves edits and distinguishes a return to the document", () => {
  const filter = new ObservationFilter();
  expect(filter.accept(snapshot())).toMatchObject({
    observation: { kind: "edit", sequence: 1 },
  });
  expect(filter.accept(snapshot())).toBeUndefined();
  expect(filter.accept(snapshot({ content: "Edited draft" }))).toMatchObject({
    observation: { kind: "edit", sequence: 2 },
  });
  filter.accept(
    snapshot({ source: { app: "Browser", windowId: "12" }, content: "A page" }),
  );
  expect(filter.accept(snapshot({ content: "Edited draft" }))).toMatchObject({
    observation: {
      kind: "activity",
      sequence: 4,
      content: "",
      revisitsObservationId: expect.any(String),
    },
  });
});
test.each([{ afterKey: "other-document" }, { secure: true }, { locked: true }])(
  "discards unsafe or changed sources: %j",
  (override) => {
    expect(new ObservationFilter().accept(snapshot(override))).toBeUndefined();
  },
);
test("application exclusion and truncation occur before downstream delivery", () => {
  expect(new ObservationFilter(["editor"]).accept(snapshot())).toBeUndefined();
  const event = new ObservationFilter().accept(
    snapshot({ content: "x".repeat(OBSERVATION_CONTENT_LIMIT + 500) }),
  );
  expect(event).toMatchObject({
    observation: { coverage: "partial", coverageReason: "content_limit" },
  });
  if (event?.type === "observation")
    expect(event.observation.content).toHaveLength(OBSERVATION_CONTENT_LIMIT);
});
test("the own Web UI title is excluded before transport without hiding other pages", () => {
  const html = readFileSync("src/web-ui/app/index.html", "utf8");
  expect(html).toContain("<title>ABot Runtime — Workspace</title>");
  const ownTitles = [
    "ABot Runtime",
    "ABot Runtime — Mozilla Firefox",
    "ABot Runtime - Google Chrome",
    "ABot Runtime — Workspace",
    "ABot Runtime — Workspace — Mozilla Firefox",
    "ABot Runtime — Workspace — Mozilla Firefox (Private Browsing)",
    "ABot Runtime — Workspace - Google Chrome",
    "ABot Runtime — Workspace — Google Chrome",
    "ABot Runtime — Workspace - Chromium",
    "ABot Runtime — Workspace — Chromium",
    "ABot Runtime — Workspace - Microsoft Edge",
    "ABot Runtime — Workspace - Brave",
    "ABot Runtime — Workspace - Safari",
    "ABot Runtime — Workspace — Safari",
  ];
  for (const title of ownTitles) {
    const filter = new ObservationFilter();
    expect(filter.accept(snapshot({
      source: { app: "firefox", windowId: "1", title },
      content: "Stored memories that must not be learned again",
    }))).toBeUndefined();
    expect(filter.accept(snapshot())).toMatchObject({
      observation: { sequence: 1, content: "A draft" },
    });
  }
  for (const title of [
    "ABot Runtime — A structured agent loop — Mozilla Firefox",
    "A review of ABot Runtime — Workspace — Mozilla Firefox",
    "ABot Runtime — Workspace — another site's article",
  ]) {
    expect(new ObservationFilter().accept(snapshot({
      source: { app: "firefox", windowId: "2", title },
      content: "A different page",
    }))).toMatchObject({ observation: { content: "A different page" } });
  }
});
test("returning from the excluded Web UI records only an empty revisit", () => {
  const filter = new ObservationFilter();
  const first = filter.accept(snapshot());
  expect(first?.type).toBe("observation");
  expect(filter.accept(snapshot({
    source: {
      app: "firefox",
      windowId: "2",
      title: "ABot Runtime — Workspace — Mozilla Firefox",
    },
    content: "The user's existing stored memory",
  }))).toBeUndefined();
  expect(filter.accept(snapshot())).toMatchObject({
    observation: {
      kind: "activity",
      sequence: 2,
      content: "",
      revisitsObservationId: first?.type === "observation"
        ? first.observation.id
        : undefined,
    },
  });
});
test("returning from an excluded application records an empty revisit", () => {
  const filter = new ObservationFilter(["browser"]);
  const first = filter.accept(snapshot());
  expect(filter.accept(snapshot({
    source: { app: "Browser", windowId: "2" },
    content: "Excluded application content",
  }))).toBeUndefined();
  expect(filter.accept(snapshot())).toMatchObject({
    observation: {
      kind: "activity", sequence: 2, content: "",
      revisitsObservationId: first?.type === "observation"
        ? first.observation.id : undefined,
    },
  });
  expect(filter.accept(snapshot())).toBeUndefined();
});
test("malformed native observations never advance the sequence", () => {
  const filter = new ObservationFilter();
  expect(filter.accept(snapshot({ extraction: "invented" }))).toBeUndefined();
  expect(filter.accept(snapshot())).toMatchObject({
    observation: { sequence: 1 },
  });
});
test("multibyte evidence remains within the framed transport budget", () => {
  const event = new ObservationFilter().accept(
    snapshot({ content: "漢".repeat(OBSERVATION_CONTENT_LIMIT) }),
  );
  expect(Buffer.byteLength(JSON.stringify(event))).toBeLessThan(
    64 * 1024 - 512,
  );
  expect(event).toMatchObject({
    observation: {
      coverage: "partial",
      coverageReason: "transport_content_limit",
    },
  });
});
test("unchanged coverage status does not generate repeated updates", () => {
  const filter = new ObservationFilter();
  const status = {
    type: "status",
    state: "partial",
    reason: "atspi_application_coverage",
  };
  expect(filter.accept(status)).toEqual(status);
  expect(filter.accept(status)).toBeUndefined();
});
test("same title across processes or documents never merges sources", () => {
  const filter = new ObservationFilter();
  const first = {
    app: "Editor",
    windowId: "1",
    processId: 10,
    documentId: "a",
    title: "Untitled",
  };
  expect(filter.accept(snapshot({ source: first }))).toMatchObject({
    observation: { kind: "edit" },
  });
  expect(
    filter.accept(snapshot({ source: { ...first, processId: 11 } })),
  ).toMatchObject({ observation: { kind: "edit", content: "A draft" } });
  expect(
    filter.accept(snapshot({ source: { ...first, documentId: "b" } })),
  ).toMatchObject({ observation: { kind: "edit", content: "A draft" } });
});
test("native collector is opt-in, lease-bound, and late callbacks cannot publish after stop", () => {
  vi.useFakeTimers();
  const send = vi.fn();
  const close = vi.fn();
  let emit!: (event: PassiveCollectorEvent) => void;
  const start = vi.fn((options) => {
    emit = options.onEvent;
    return { close };
  });
  const session = new NativeObservationSession(send, start);
  expect(start).not.toHaveBeenCalled();
  const control = {
    type: "observe_start" as const,
    ownerId: "dev",
    leaseId: randomUUID(),
  };
  session.receive(control);
  emit({ type: "status", state: "collecting" });
  expect(send).toHaveBeenCalledOnce();
  vi.advanceTimersByTime(OBSERVATION_LEASE_MS - 1);
  session.receive({ ...control, type: "observe_renew" });
  vi.advanceTimersByTime(OBSERVATION_LEASE_MS - 1);
  expect(close).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(close).toHaveBeenCalledOnce();
  emit({ type: "status", state: "collecting" });
  expect(send).toHaveBeenCalledOnce();
});
test("one environment owns the device and its identity is bound by the host connection", () => {
  vi.useFakeTimers();
  const send = vi.fn();
  const socket = { readyState: WebSocket.OPEN, send } as unknown as WebSocket;
  const connection = new HostObservationConnection();
  const deviceId = randomUUID();
  connection.attach(socket, deviceId, true);
  const leaseId = randomUUID();
  const onEvent = vi.fn();
  const lease = connection.subscribe({ ownerId: "dev", leaseId, onEvent });
  expect(() =>
    connection.subscribe({ ownerId: "prod", leaseId: randomUUID(), onEvent }),
  ).toThrow("already_owned");
  connection.receive(socket, {
    ownerId: "dev",
    leaseId,
    deviceId: "forged",
    event: { type: "status", state: "collecting" },
  });
  expect(onEvent).toHaveBeenCalledWith({
    type: "status",
    state: "collecting",
    deviceId,
    ownerId: "dev",
    leaseId,
  });
  connection.receive(socket, {
    ownerId: "prod",
    leaseId,
    event: { type: "status", state: "collecting" },
  });
  expect(onEvent).toHaveBeenCalledOnce();
  lease.close();
  expect(JSON.parse(send.mock.calls.at(-1)![0])).toMatchObject({
    type: "observe_stop",
    leaseId,
  });
});
test("old companions decline observation subscriptions while remaining attached", () => {
  const connection = new HostObservationConnection();
  const send = vi.fn();
  connection.attach(
    { readyState: WebSocket.OPEN, send } as unknown as WebSocket,
    randomUUID(),
    false,
  );
  expect(() =>
    connection.subscribe({
      ownerId: "dev",
      leaseId: randomUUID(),
      onEvent: vi.fn(),
    }),
  ).toThrow("unsupported");
  expect(send).not.toHaveBeenCalled();
});
test("sequence replay is dropped and disconnection revokes the device lease", () => {
  vi.useFakeTimers();
  const connection = new HostObservationConnection();
  const socket = {
    readyState: WebSocket.OPEN,
    send: vi.fn(),
  } as unknown as WebSocket;
  connection.attach(socket, randomUUID(), true);
  const onEvent = vi.fn();
  const leaseId = randomUUID();
  const lease = connection.subscribe({ ownerId: "dev", leaseId, onEvent });
  const event = new ObservationFilter().accept(snapshot())!;
  connection.receive(socket, { ownerId: "dev", leaseId, event });
  connection.receive(socket, { ownerId: "dev", leaseId, event });
  expect(onEvent).toHaveBeenCalledOnce();
  connection.disconnect();
  expect(onEvent).toHaveBeenLastCalledWith(
    expect.objectContaining({ state: "disconnected" }),
  );
  expect(() => lease.renew()).toThrow("expired");
});
test("Linux autostart runs in the desktop login session and no platform command collects until started", () => {
  const options = {
    platform: "linux" as const,
    homeDir: "/fixture-home",
    nodePath: "/usr/bin/node",
    cliPath: "/opt/abot/bin.js",
    stateDir: "/fixture-home/.abot",
  };
  expect(nativeAutostartFile(options)).toBe(
    "/fixture-home/.config/autostart/com.abot.host-companion.desktop",
  );
  expect(renderNativeAutostart(options)).toContain(
    'Exec="/usr/bin/node" "/opt/abot/bin.js" host run',
  );
  expect(desktopCollectorCommand("linux")?.file).toBe("python3");
  expect(desktopCollectorCommand("darwin")?.file).toBe("/usr/bin/swift");
  expect(desktopCollectorCommand("win32")?.file).toBe("powershell.exe");
  expect(desktopCollectorCommand("freebsd")).toBeUndefined();
});
