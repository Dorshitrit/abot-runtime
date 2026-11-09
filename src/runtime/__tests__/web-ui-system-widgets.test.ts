import { expect, test, vi } from "vitest";
// @ts-expect-error Browser-only controller.
import { createSystemWidgetsController } from "../../web-ui/app/controllers/system-widgets-controller.js";
// @ts-expect-error Browser-only native cards.
import { renderSystemWidget, systemFeatureSuggestions } from "../../web-ui/app/components/system-widgets/cards.js";
import { FakeElement } from "./support/model-setup-wizard-harness.js";

const candidate = { id: "candidate", revision: 2, content: "Useful user preference" };
function fixture() {
  let environment = "dev";
  const client = {
    supportsSkills: vi.fn(() => true), supportsInformationBasket: vi.fn(() => true),
    listPersonalSkills: vi.fn(async (_env: string) => ({ items: [] as unknown[] })),
    listInformationBasket: vi.fn(async (_env: string) => ({ sources: [], settings: { enabled: true } })),
    loadPassiveLearning: vi.fn(async (_env: string) => ({ status: { preferences: { activityPermissions: { learning: true, proactive: true } } } })),
    listPassiveLearningCandidates: vi.fn(async (_env: string) => ({ items: [candidate] })),
    promoteLearningCandidate: vi.fn(async (_input: unknown) => ({ record: { id: "approved" } })),
    deleteLearningCandidate: vi.fn(async (_input: unknown) => ({ deleted: true })),
  };
  const render = vi.fn();
  const controller = createSystemWidgetsController({ client, getEnvironmentId: () => environment, render });
  return { client, controller, render, setEnvironment(value: string) { environment = value; controller.environmentChanged(); } };
}

test("native widget reads are limited to mounted known IDs and remain idle until active", async () => {
  const f = fixture();
  f.controller.setWidgets(["skills", "skills", "arbitrary-tool"]);
  expect(f.client.listPersonalSkills).not.toHaveBeenCalled();
  f.controller.setActive(true);
  await vi.waitFor(() => expect(f.controller.snapshot().sources.skills?.data).toEqual({ items: [] }));
  expect(f.client.listPersonalSkills).toHaveBeenCalledOnce();
  expect(f.client.listInformationBasket).not.toHaveBeenCalled();
  expect(f.client.listPassiveLearningCandidates).not.toHaveBeenCalled();
  expect(f.client.loadPassiveLearning).not.toHaveBeenCalled();
  f.controller.setActive(false);
  f.controller.setWidgets(["memory-candidates"]);
  await f.controller.refresh();
  expect(f.client.listPassiveLearningCandidates).not.toHaveBeenCalled();
  f.controller.setActive(true);
  await vi.waitFor(() => expect(f.controller.snapshot().candidates).toEqual([candidate]));
  expect(f.client.listPassiveLearningCandidates).toHaveBeenCalledWith("dev");
});

test("feature discovery deduplicates shared reads and unsupported sources are not fetched", async () => {
  const f = fixture();
  f.client.supportsSkills.mockReturnValue(false);
  f.controller.setWidgets(["feature-discovery", "resources", "skills"]);
  f.controller.setActive(true);
  await vi.waitFor(() => expect(f.controller.snapshot().sources.resources?.data).toBeDefined());
  expect(f.client.listPersonalSkills).not.toHaveBeenCalled();
  expect(f.client.listInformationBasket).toHaveBeenCalledOnce();
  expect(f.client.loadPassiveLearning).toHaveBeenCalledOnce();
  expect(f.client.listPassiveLearningCandidates).not.toHaveBeenCalled();
  expect(f.controller.snapshot().sources.skills).toMatchObject({ supported: false, loading: false });
});

test("an old environment read cannot restore private widget data after an environment change", async () => {
  const f = fixture();
  let resolve!: (value: { items: unknown[] }) => void;
  f.client.listPersonalSkills.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  f.controller.setWidgets(["skills"]); f.controller.setActive(true);
  f.setEnvironment("prod");
  await vi.waitFor(() => expect(f.controller.snapshot().sources.skills?.data).toEqual({ items: [] }));
  resolve({ items: [{ skillId: "private-dev", source: "personal", name: "Private" }] });
  await Promise.resolve();
  expect(f.controller.snapshot()).toMatchObject({ environmentId: "prod", sources: { skills: { data: { items: [] } } } });
  expect(f.client.listPersonalSkills).toHaveBeenLastCalledWith("prod");
});

test("native candidate mutations use current revision and refresh canonical data after a confirmed receipt", async () => {
  const f = fixture();
  f.controller.setWidgets(["memory-candidates"]); f.controller.setActive(true);
  await vi.waitFor(() => expect(f.controller.snapshot().candidates).toEqual([candidate]));
  await f.controller.promoteCandidate({ id: "candidate", revision: 1, environmentId: "dev" });
  expect(f.client.promoteLearningCandidate).not.toHaveBeenCalled();
  f.client.listPassiveLearningCandidates.mockResolvedValue({ items: [] });
  await f.controller.promoteCandidate({ id: "candidate", revision: 2, environmentId: "dev" });
  expect(f.client.promoteLearningCandidate).toHaveBeenCalledWith({ id: "candidate", revision: 2, environmentId: "dev" });
  expect(f.controller.snapshot().candidates).toEqual([]);
  f.controller.setActive(false);
  await f.controller.deleteCandidate({ id: "candidate", revision: 2, environmentId: "dev" });
  expect(f.client.deleteLearningCandidate).not.toHaveBeenCalled();
});

test("unavailable or failed reads never imply inactive features", () => {
  const unknown = { skills: { supported: false }, resources: { error: "offline" }, learning: { error: "offline" } };
  expect(systemFeatureSuggestions(unknown)).toEqual([]);
  expect(renderSystemWidget("feature-discovery", { sources: unknown })).toBe("");
  const active = { skills: { data: { items: [{ source: "personal", archived: false }] } },
    resources: { data: { sources: [{}], settings: { enabled: true } } },
    learning: { data: { status: { preferences: { activityPermissions: { learning: true, proactive: true } } } } } };
  expect(systemFeatureSuggestions(active)).toEqual([]);
  expect(renderSystemWidget("feature-discovery", { sources: active })).toBe("");
  const inactive = { ...active, learning: { data: { status: { preferences: { activityPermissions: { learning: false, proactive: true } } } } } };
  expect(systemFeatureSuggestions(inactive)).toEqual([expect.objectContaining({ action: "spark-settings" })]);
  const unavailableCached = { skills: { supported: false, data: { items: [] } },
    resources: { error: "offline", data: { sources: [], settings: { enabled: false } } },
    learning: { error: "offline", data: inactive.learning.data } };
  expect(systemFeatureSuggestions(unavailableCached)).toEqual([]);
});

test("source strings are escaped in native cards and only known action IDs are rendered", () => {
  const dangerous = '<img src=x onerror="steal()">';
  const state = { sources: {
    candidates: { data: { items: [] } }, skills: { data: { items: [{ source: "personal", archived: false, skillId: '\" onclick=\"bad()', name: dangerous, description: dangerous }] } },
    resources: { data: { sources: [{ sourceId: '\" onclick=\"bad()', displayName: dangerous, status: "ready" }] } },
  }, candidates: [{ ...candidate, content: dangerous }] };
  const document = {} as ConstructorParameters<typeof FakeElement>[1];
  document.createElement = tag => new FakeElement(tag, document);
  const root = document.createElement("section");
  for (const id of ["memory-candidates", "skills", "resources"]) {
    root.innerHTML = renderSystemWidget(id, state);
    expect(root.querySelector("img")).toBeNull();
    expect(root.querySelector("[onclick]")).toBeNull();
    expect(root.textContent).toContain(dangerous);
  }
  expect(renderSystemWidget("unknown-widget", state)).toBe("");
});
