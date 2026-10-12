import type { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, expect, test, vi } from "vitest";
import { startDesktopCollector } from "../../computer-access/companion/observation-process.js";
import type { PassiveCollectorEvent, PassiveObservationSource } from "../../shared/passive-observation.js";

const collectors: Array<{ close(): void }> = [];
afterEach(() => {
  for (const collector of collectors.splice(0)) collector.close();
});

function collector(excludedApplications: readonly string[] = []) {
  // No PID: neither startup nor shutdown may act on a real desktop process.
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(),
  });
  const spawnProcess = vi.fn<typeof spawn>().mockReturnValue(child as unknown as ReturnType<typeof spawn>);
  const events: PassiveCollectorEvent[] = [];
  collectors.push(startDesktopCollector({
    platform: "win32", excludedApplications,
    spawnProcess: spawnProcess as unknown as typeof spawn, onEvent: (event) => events.push(event),
  }));
  function snapshot(source: PassiveObservationSource, content = "Visible content") {
    child.stdout.write(JSON.stringify({
      type: "snapshot", source, content, kind: "view", extraction: "uia", coverage: "partial",
      beforeKey: source.windowId, afterKey: source.windowId,
    }) + "\n");
  }
  return { events, snapshot };
}

test.each([
  { app: "ABot", title: "ABot - QA" },
  { app: "abot", title: "ABot" },
  { app: "ABOT", title: "Spark settings" },
  { app: "ABot", title: "A conversation with a changing title" },
  { app: "ABot" },
])("the built-in Desktop exclusion rejects $app / $title before delivery", (source) => {
  const f = collector();
  f.snapshot({ ...source, windowId: "abot-window", processId: 100 }, "Memory that must not be learned again");
  expect(f.events).toEqual([{ type: "status", state: "starting" }]);
  f.snapshot({ app: "Editor", windowId: "document" });
  expect(f.events.at(-1)).toMatchObject({
    type: "observation", observation: { sequence: 1, content: "Visible content" },
  });
});

test.each(["ABot-helper", "ExampleABot", "msedgewebview2", "node", "firefox", "msedge"])(
  "the built-in exclusion does not hide other application %s",
  (app) => {
    const f = collector();
    f.snapshot({ app, windowId: "other-window", title: "An article about ABot" }, "ABot - QA");
    expect(f.events.at(-1)).toMatchObject({
      type: "observation", observation: { source: { app }, content: "ABot - QA", sequence: 1 },
    });
  },
);

test.each([
  { rules: [], expectedEvents: 2 },
  { rules: ["PrivateApp"], expectedEvents: 1 },
])("Desktop self-exclusion remains mandatory with user rules $rules", ({ rules, expectedEvents }) => {
  const preferences = Object.freeze([...rules]);
  const f = collector(preferences);
  f.snapshot({ app: "ABot", windowId: "abot-window", title: "ABot - QA" });
  expect(f.events).toHaveLength(1);
  f.snapshot({ app: "privateapp", windowId: "private-window" });
  expect(f.events).toHaveLength(expectedEvents);
  expect(preferences).toEqual(rules);
});

test("returning from Desktop keeps the original observation as an empty revisit", () => {
  const f = collector();
  const document = { app: "Editor", windowId: "document", processId: 101 };
  f.snapshot(document, "Original draft");
  const first = f.events.at(-1);
  if (first?.type !== "observation") throw new Error("Missing initial observation");
  f.snapshot({ app: "ABot", windowId: "abot-window" }, "Stored memories");
  f.snapshot({ app: "ABot", windowId: "abot-window", title: "Another ABot page" }, "Other stored memories");
  expect(f.events).toHaveLength(2);
  f.snapshot(document, "Original draft");
  expect(f.events.at(-1)).toMatchObject({
    type: "observation", observation: {
      sequence: 2, kind: "activity", content: "", revisitsObservationId: first.observation.id,
    },
  });
  f.snapshot(document, "Original draft");
  expect(f.events).toHaveLength(3);
  f.snapshot(document, "Edited draft");
  expect(f.events.at(-1)).toMatchObject({
    type: "observation", observation: { sequence: 3, content: "Edited draft" },
  });
});

test("Web UI self-exclusion still applies through the same collector boundary", () => {
  const f = collector();
  f.snapshot({ app: "msedge", windowId: "browser", title: "ABot Runtime — Workspace - Microsoft Edge" });
  expect(f.events).toHaveLength(1);
  f.snapshot({ app: "msedge", windowId: "browser", title: "An article about ABot Runtime — Workspace - Microsoft Edge" });
  expect(f.events.at(-1)).toMatchObject({ type: "observation", observation: { sequence: 1 } });
});
