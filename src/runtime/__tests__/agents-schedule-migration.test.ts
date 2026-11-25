import { readFile, writeFile } from "node:fs/promises";
import { afterEach, expect, test } from "vitest";
import { agentsScheduleFixture } from "./support/agents-schedule-fixture.js";
const fixtures: Awaited<ReturnType<typeof agentsScheduleFixture>>[] = [];
afterEach(async () => { for (const f of fixtures.splice(0)) await f.dispose(); });
async function legacyFixture(claimed = false) {
  const f = await agentsScheduleFixture(); fixtures.push(f); await f.service.create(f.input);
  if (claimed) { f.advance(1000); await f.claim(); }
  const legacy = JSON.parse(await readFile(f.filename, "utf8"));
  legacy.schemaVersion = 1; legacy.schedules[0].agentId = "spark";
  const bytes = JSON.stringify(legacy); await writeFile(f.filename, bytes);
  f.setDetail({ ...f.detail(), agent: { ...f.detail().agent, id: "abot" } });
  return { ...f, bytes, legacy };
}

test("legacy coordinator schedules project to ABot without rewriting durable bytes or authority", async () => {
  const f = await legacyFixture(); const [projected] = await f.service.list("abot");
  expect(projected).toEqual({ ...f.legacy.schedules[0], agentId: "abot" });
  expect(await readFile(f.filename, "utf8")).toBe(f.bytes);
  f.advance(1000); await f.service.tick();
  expect(f.send).toHaveBeenCalledExactlyOnceWith("abot", expect.objectContaining({ messageId: "agent-schedule:schedule-a:1", expectedAgentRevision: 1 }));
  expect(JSON.parse(await readFile(f.filename, "utf8"))).toMatchObject({ schemaVersion: 2,
    schedules: [{ agentId: "abot", binding: f.legacy.schedules[0].binding, occurrences: [{ status: "accepted", binding: f.legacy.schedules[0].binding }] }] });
});

test("migration preserves claimed occurrence identity and reconciles the migrated message without replay", async () => {
  const f = await legacyFixture(true); const occurrence = f.legacy.schedules[0].occurrences[0];
  f.setDetail({ ...f.detail(), messages: [{ id: occurrence.messageId, agentId: "abot", missionId: "accepted-mission",
    role: "user", purpose: "request", source: null, text: f.input.text, createdAt: f.input.startAt }] });
  const [projection] = await f.service.list("abot"); expect(projection?.occurrences[0]).toEqual(occurrence);
  expect(projection?.revision).toBe(f.legacy.schedules[0].revision);
  const restored = f.another(); await restored.start();
  expect(f.send).not.toHaveBeenCalled();
  expect((await restored.list("abot"))[0]).toMatchObject({ status: "completed", binding: f.legacy.schedules[0].binding,
    occurrences: [{ messageId: occurrence.messageId, status: "accepted", missionId: "accepted-mission", binding: occurrence.binding }] });
});
