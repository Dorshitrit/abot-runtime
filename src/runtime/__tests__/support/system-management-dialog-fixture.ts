import { vi } from "vitest";
import { FakeElement } from "./model-setup-wizard-harness.js";
// @ts-expect-error Browser-only module.
import { createSystemManagementDialog } from "../../../web-ui/app/components/system-widgets/management-dialog.js";

export const managedSkill = { skillId: "personal/guide", name: "Guide", description: "Personal guidance",
  content: "Original guidance", source: "personal", revision: 2, archived: false };
export const managedSource = { sourceId: "source-a", displayName: "Notes.md", path: "/documents/Notes.md",
  revision: 3, status: "ready", sizeBytes: 100, chunkCount: 1, indexedAt: null, reason: null };

export function managementDialogFixture(overrides = {}) {
  const documentRoot = {} as ConstructorParameters<typeof FakeElement>[1];
  documentRoot.createElement = (tag) => new FakeElement(tag, documentRoot);
  documentRoot.documentElement = documentRoot.createElement("html");
  documentRoot.body = documentRoot.createElement("body");
  const trigger = documentRoot.createElement("button");
  documentRoot.body.append(trigger); trigger.focus();
  let environment = "dev";
  let skills = [{ ...managedSkill }];
  let sources = [{ ...managedSource }];
  let settings = { revision: 1, enabled: true, embeddingProfileId: "local", indexChatUploads: false, matchMode: "balanced" };
  const resourceView = () => ({ settings: { ...settings }, sources: sources.map((source) => ({ ...source })),
    embeddingProfiles: [{ id: "local", label: "Local", model: "embed" }], supportedExtensions: [".md"], limits: { maxSources: 200 } });
  const client = {
    supportsSkills: () => true, supportsInformationBasket: () => true,
    listPersonalSkills: vi.fn(async () => ({ items: skills.map((skill) => ({ ...skill })) })),
    readPersonalSkill: vi.fn(async (id: string) => ({ skill: { ...skills.find((skill) => skill.skillId === id)! } })),
    createPersonalSkill: vi.fn(async (input: { name: string; description: string; content: string }) => {
      const skill = { ...managedSkill, ...input, skillId: "personal/new", revision: 1 }; skills.push(skill); return { skill };
    }),
    updatePersonalSkill: vi.fn(async (id: string, content: string) => {
      skills = skills.map((skill) => skill.skillId === id ? { ...skill, content, revision: skill.revision + 1 } : skill);
      return { skill: { ...skills.find((skill) => skill.skillId === id)! } };
    }),
    archivePersonalSkill: vi.fn(async (id: string) => {
      skills = skills.map((skill) => skill.skillId === id ? { ...skill, archived: true, revision: skill.revision + 1 } : skill);
      return { skill: { ...skills.find((skill) => skill.skillId === id)! } };
    }),
    restorePersonalSkill: vi.fn(async (id: string) => {
      skills = skills.map((skill) => skill.skillId === id ? { ...skill, archived: false, revision: skill.revision + 1 } : skill);
      return { skill: { ...skills.find((skill) => skill.skillId === id)! } };
    }),
    listInformationBasket: vi.fn(async () => resourceView()),
    saveInformationBasketSettings: vi.fn(async (input: Omit<typeof settings, "revision">) => {
      settings = { ...settings, ...input, revision: settings.revision + 1 }; return resourceView();
    }),
    removeInformationBasketSource: vi.fn(async (id: string) => { sources = sources.filter((source) => source.sourceId !== id); return resourceView(); }),
    reindexInformationBasketSource: vi.fn(async (id: string) => {
      sources = sources.map((source) => source.sourceId === id ? { ...source, status: "queued", revision: source.revision + 1 } : source);
      return resourceView();
    }),
    registerInformationBasketSources: vi.fn(async (paths: string[]) => {
      sources = [...sources, ...paths.map((path, index) => ({ ...managedSource, path, sourceId: `added-${index}` }))];
      return resourceView();
    }),
    browseInformationBasket: vi.fn(async () => ({ directory: "/documents", parent: "/", roots: [], nextCursor: null,
      entries: [{ name: "Next.md", path: "/documents/Next.md", kind: "file", supported: true }] })),
    ...overrides,
  };
  const onChanged = vi.fn();
  const manager = createSystemManagementDialog({ client, getEnvironmentId: () => environment, documentRoot, onChanged });
  const root = documentRoot.body.querySelector(".system-management-dialog")!;
  const find = (selector: string) => root.querySelector(selector)!;
  const confirm = (approve: boolean) => documentRoot.body.querySelector(approve ? "[data-confirmation-accept]" : "[data-confirmation-cancel]")!.dispatch("click");
  const input = (selector: string, value: string) => { const node = find(selector); node.value = value; node.dispatch("input"); };
  return { manager, root, find, input, confirm, client, trigger, documentRoot, onChanged, resourceView,
    setEnvironment(value: string) { environment = value; manager.environmentChanged(); } };
}

export function deferredManagement<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}
