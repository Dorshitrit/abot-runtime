import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, test } from "vitest";
import { createRuntimeKnowledgeSkillStore } from "../knowledge-skills/personal-store.js";
import { PERSONAL_SKILL_LIMITS } from "../knowledge-skills/personal-contracts.js";
import { PersonalSkillManagementRoutes } from "../../web-ui/local-runtime/skill-management-routes.js";
import { pathSegments, readBody, readJsonBody, requestEnvironmentId, sendJson } from "../../web-ui/local-runtime/http.js";
import { createLocalServiceClients } from "../local-host/client-services.js";
import { dispatchLocalServiceCall } from "../local-host/app-service-dispatch.js";
import { createLocalRuntimeConnection } from "../local-host/transport.js";
import type { RuntimeEnvironmentServices } from "../composition.js";
import type { PersonalSkillManagementService } from "../knowledge-skills/personal-contracts.js";

const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.closeAllConnections();
    server.close((error) => error ? reject(error) : resolve());
  })));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "personal-skills-web-"));
  roots.push(root);
  const dev = createRuntimeKnowledgeSkillStore(join(root, "dev"));
  const prod = createRuntimeKnowledgeSkillStore(join(root, "prod"));
  const skill = await dev.create({ name: "Daily summary", description: "Summarize today's news.", content: "Read available sources." });
  const base = await startServer((id) => id === "prod" ? prod.personalSkills : dev.personalSkills);
  return { root, dev, prod, skill, base, item: `${base}/${skill.skillId}` };
}
async function startServer(resolve: (id: string) => PersonalSkillManagementService | undefined) {
  const routes = new PersonalSkillManagementRoutes(resolve);
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, "http://localhost");
    const method = request.method ?? "GET";
    const body = method === "GET" ? null : readJsonBody(await readBody(request));
    const handled = await routes.handle({ method, request, response, body,
      segments: pathSegments(url.pathname.slice("/web-api".length)),
      environmentId: requestEnvironmentId(url, body, "dev") });
    if (!handled) sendJson(response, 404, { error: "not_found" });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/web-api/runtime/skills`;
}
function json(method: string, body: unknown, headers: Record<string, string> = {}) {
  return { method, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) };
}

test("personal-only metadata and explicit content loads stay environment scoped", async () => {
  const { dev, prod, skill, base, item } = await fixture();
  const list = await (await fetch(base)).json();
  expect(list.items).toEqual([{ ...skill, content: undefined, archived: false }]);
  expect(Object.hasOwn(list.items[0], "content")).toBe(false);
  expect(await (await fetch(item)).json()).toEqual({ ok: true, skill: { ...skill, archived: false } });
  expect(await (await fetch(`${base}?environment=prod`)).json()).toEqual({ ok: true, items: [] });
  expect((await fetch(`${item}?environment=prod`)).status).toBe(404);
  const systemId = dev.list().find((entry) => entry.source === "system")!.skillId;
  expect((await fetch(`${base}/${systemId}`)).status).toBe(403);
  expect(await prod.personalSkills.list()).toEqual([]);
});

test("content edits, archive and restore share model state and enforce revisions", async () => {
  const { dev, skill, item } = await fixture();
  const edited = await fetch(item, json("PATCH", { content: "Read and cite sources.", expectedRevision: 1 }));
  expect(edited.status).toBe(200);
  expect(await edited.json()).toMatchObject({ skill: { ...skill, content: "Read and cite sources.", revision: 2, archived: false } });
  const stale = await fetch(`${item}/archive`, json("POST", { expectedRevision: 1 }));
  expect(stale.status).toBe(409);
  expect(await stale.json()).toEqual({ ok: false, error: "knowledge_skill_revision_conflict" });
  const archived = await fetch(`${item}/archive`, json("POST", { expectedRevision: 2 }));
  expect(await archived.json()).toMatchObject({ skill: { archived: true, revision: 3 } });
  expect(dev.read(skill.skillId)).toBeUndefined();
  expect(dev.list().some((entry) => entry.skillId === skill.skillId)).toBe(false);
  expect((await fetch(item, json("PATCH", { content: "Overwrite", expectedRevision: 3 }))).status).toBe(409);
  expect(await (await fetch(item)).json()).toMatchObject({ skill: { content: "Read and cite sources.", archived: true } });
  expect(await (await fetch(`${item}/restore`, json("POST", { expectedRevision: 3 }))).json())
    .toMatchObject({ skill: { revision: 4, archived: false } });
  expect(dev.read(skill.skillId)).toMatchObject({ content: "Read and cite sources.", revision: 4 });
});

test("management rejects metadata edits, oversized content, core mutations and cross-origin writes", async () => {
  const { dev, skill, item, base } = await fixture();
  for (const extra of [{ name: "Renamed" }, { skillId: "another" }, { description: "Changed" }, { archived: true }]) {
    expect((await fetch(item, json("PATCH", { ...extra, content: "Changed", expectedRevision: 1 }))).status).toBe(400);
  }
  expect((await fetch(item, json("PATCH", { content: "x".repeat(PERSONAL_SKILL_LIMITS.contentBytes + 1), expectedRevision: 1 }))).status).toBe(400);
  expect((await fetch(item, json("PATCH", { content: "Changed", expectedRevision: "1" }))).status).toBe(400);
  expect((await fetch(item, json("PATCH", { content: "Changed", expectedRevision: 1 }, { origin: "https://elsewhere.test" }))).status).toBe(403);
  expect((await fetch(`${item}/archive`, { method: "POST", body: JSON.stringify({ expectedRevision: 1 }) })).status).toBe(415);
  const systemId = dev.list().find((entry) => entry.source === "system")!.skillId;
  expect((await fetch(`${base}/${systemId}/archive`, json("POST", { expectedRevision: 1 }))).status).toBe(403);
  expect((await fetch(base, json("PUT", {}))).status).toBe(405);
  expect((await fetch(item, json("DELETE", {}))).status).toBe(405);
  expect(dev.read(skill.skillId)).toEqual(skill);
});

test("manual creation generates identity and uses only the selected environment", async () => {
  const { dev, prod, base } = await fixture();
  const input = { name: "My workflow", description: "For project development.", content: "Follow project conventions." };
  for (const extra of [{ skillId: "chosen-id" }, { source: "system" }, { revision: 55 }, { archived: true }]) {
    expect((await fetch(base, json("POST", { ...input, ...extra }))).status).toBe(400);
  }
  expect((await fetch(base, json("POST", { ...input, name: " " }))).status).toBe(400);
  expect((await fetch(base, json("POST", input, { origin: "https://elsewhere.test" }))).status).toBe(403);
  const created = await fetch(`${base}?environment=prod`, json("POST", input));
  expect(created.status).toBe(201);
  const { skill } = await created.json();
  expect(skill).toEqual({ ...input, source: "personal", archived: false, revision: 1, skillId: expect.stringMatching(/^personal-/) });
  expect(dev.read(skill.skillId)).toBeUndefined();
  expect(prod.read(skill.skillId)).toMatchObject({ ...input, revision: 1 });
  expect(await (await fetch(`${base}/${skill.skillId}?environment=prod`)).json()).toEqual({ ok: true, skill });
});

test("unavailable and transported failures expose only stable error codes", async () => {
  const absent = await startServer(() => undefined);
  expect((await fetch(absent)).status).toBe(503);
  const store = { list: async () => { throw Object.assign(new Error("private filesystem details"), { code: "knowledge_skill_storage_invalid" }); } } as unknown as PersonalSkillManagementService;
  const base = await startServer(() => store);
  expect(await (await fetch(base)).json()).toEqual({ ok: false, error: "knowledge_skill_storage_invalid" });
});

test("existing owner RPC serves the same Store, preserves conflicts and denies extra operations", async () => {
  const { root, dev, skill } = await fixture();
  const services = { personalSkills: dev.personalSkills } as RuntimeEnvironmentServices;
  const connection = await createLocalRuntimeConnection({ directory: join(root, "owner"), identity: "skills-rpc-test",
    createOwner: async () => ({ call: (method, args) => dispatchLocalServiceCall(services, method, args),
      subscribe: () => () => undefined, stop: async () => undefined }) });
  try {
    const client = createLocalServiceClients(connection.call).personalSkills;
    const added = await client.create({ name: "RPC Skill", description: "Created through the owner.", content: "Keep the same Store." });
    expect(dev.read(added.skillId)).toMatchObject({ name: "RPC Skill", revision: 1 });
    expect(await client.get(skill.skillId)).toMatchObject({ ...skill, archived: false });
    expect(await client.archive(skill.skillId, 1)).toMatchObject({ archived: true, revision: 2 });
    expect(dev.read(skill.skillId)).toBeUndefined();
    await expect(client.updateContent(skill.skillId, 1, "stale")).rejects.toMatchObject({ code: "knowledge_skill_revision_conflict" });
    await expect(connection.call("personalSkills.delete", [])).rejects.toThrow("local_runtime_method_unknown");
    await expect(connection.call("personalSkills.constructor", [])).rejects.toThrow("local_runtime_method_unknown");
    await expect(connection.call("personalSkills.get.extra", [])).rejects.toThrow("local_runtime_method_unknown");
    expect(await client.restore(skill.skillId, 2)).toMatchObject({ revision: 3, archived: false });
    expect(dev.read(skill.skillId)).toMatchObject({ ...skill, revision: 3 });
  } finally { await connection.close(); }
});
