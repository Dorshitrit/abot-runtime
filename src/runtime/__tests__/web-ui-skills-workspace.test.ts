import { expect, test, vi } from "vitest";
import { FakeElement } from "./support/model-setup-wizard-harness.js";
// @ts-expect-error Browser-only module.
import { createSkillsWorkspace, renderSkillRows } from "../../web-ui/app/components/skills/workspace.js";
// @ts-expect-error Browser-only module.
import { createWorkspaceShell } from "../../web-ui/app/components/workspace-shell.js";
import { createWorkspaceShellHarness } from "./support/workspace-shell-harness.js";
import { readWorkspaceRoute, workspaceRouteUrl } from "../../web-ui/app/lib/workspace-route.js";
const skill = { skillId: "personal/one", name: "My guide", description: "Team conventions", source: "personal", revision: 2, archived: false, content: "Existing guidance" };
const snapshot = { items: [skill], skill, draft: skill.content, dirty: false, archived: false,
  loading: false, reading: false, mutation: "", error: "", message: "" };
function createView(confirmArchive = vi.fn(() => false)) {
  const document = {} as ConstructorParameters<typeof FakeElement>[1];
  document.createElement = (tag) => new FakeElement(tag, document);
  document.documentElement = document.createElement("html"); document.body = document.createElement("body");
  const root = document.createElement("section"); document.body.append(root);
  const actions = { beginCreate: vi.fn(), cancelCreate: vi.fn(), setCreationField: vi.fn(), select: vi.fn(), setArchived: vi.fn(), setDraft: vi.fn(), save: vi.fn(),
    archive: vi.fn(), restore: vi.fn(), refresh: vi.fn(), reloadSelected: vi.fn() };
  const view = createSkillsWorkspace({ root, actions, confirmArchive }); view.render(snapshot);
  return { root, actions, view, confirmArchive };
}

test("list escapes metadata and shows only the selected personal status", () => {
  const evil = { ...skill, skillId: '\" onclick=\"bad()', name: '<img src=x onerror=bad()>', description: '<script>bad()</script>' };
  const html = renderSkillRows({ ...snapshot, items: [evil, { ...skill, name: "Core", source: "system" }, { ...skill, name: "Old", archived: true }] });
  expect(html).toContain("&lt;img"); expect(html).toContain("&lt;script&gt;"); expect(html).not.toContain("<img");
  expect(html).not.toContain(">Core<"); expect(html).not.toContain(">Old<");
  expect(html).toContain("&quot;");
});

test("editor keeps metadata read-only and treats the content as literal text", () => {
  const f = createView(); const body = '<script>bad()</script>\nשלום';
  f.view.render({ ...snapshot, draft: body, dirty: true, skill: { ...skill, name: "<img>" } });
  expect(f.root.querySelector("[data-skills-name]")!.textContent).toBe("<img>");
  expect(f.root.querySelector("[data-skills-content]")!.value).toBe(body);
  expect(f.root.querySelector("[data-skills-creation-fields]")!.hidden).toBe(true);
  expect(f.root.querySelector("[data-skills-new-name]")!.disabled).toBe(true);
  const editor = f.root.querySelector("[data-skills-content]")!; editor.value = "Changed"; editor.dispatch("input");
  expect(f.actions.setDraft).toHaveBeenCalledExactlyOnceWith("Changed");
  f.root.querySelector("[data-skills-form]")!.dispatch("submit"); expect(f.actions.save).toHaveBeenCalledOnce();
});

test("archive requires confirmation; archived records offer restore without editing", () => {
  const f = createView(); f.root.querySelector("[data-skills-archive]")!.dispatch("click");
  expect(f.actions.archive).not.toHaveBeenCalled();
  f.confirmArchive.mockReturnValue(true); f.root.querySelector("[data-skills-archive]")!.dispatch("click");
  expect(f.actions.archive).toHaveBeenCalledOnce();
  f.view.render({ ...snapshot, skill: { ...skill, archived: true }, archived: true });
  expect(f.root.querySelector("[data-skills-save]")!.hidden).toBe(true);
  expect(f.root.querySelector("[data-skills-archive]")!.hidden).toBe(true);
  f.root.querySelector("[data-skills-restore]")!.dispatch("click"); expect(f.actions.restore).toHaveBeenCalledOnce();
});

test("Skills navigation uses the existing shell, focus and discard guard", () => {
  const h = createWorkspaceShellHarness(1440);
  let mayLeave = false;
  const shell = createWorkspaceShell({ ...h });
  shell.addWorkspaceGuard(({ from }: { from: string }) => from !== "skills" || mayLeave);
  shell.bind(); shell.load(); h.dom.skillsWorkspaceButton.dispatch("click"); h.flushFrames();
  expect(shell.activeWorkspace()).toBe("skills");
  expect(h.dom.skillsWorkspacePanel.hidden).toBe(false);
  expect(h.dom.skillsWorkspacePanel.inert).toBe(false);
  expect(h.documentRoot.activeElement).toBe(h.dom.closeSkillsWorkspaceButton);
  expect(shell.closeOverlaysOnEscape()).toBe(false);
  mayLeave = true; expect(shell.closeOverlaysOnEscape()).toBe(true);
  expect(h.dom.skillsWorkspacePanel.hidden).toBe(true);
});

test("Skills address preserves environment and excludes unrelated conversation identity", () => {
  const address = workspaceRouteUrl({ workspace: "skills", environment: "dev one", session: "irrelevant" });
  expect(address).toBe("/skills?environment=dev+one");
  expect(readWorkspaceRoute(new URL(address, "http://localhost"))).toMatchObject({ workspace: "skills", environment: "dev one", session: "" });
});

test("creation UI exposes only name, description and content while existing records keep readonly metadata", () => {
  const f = createView();
  f.root.querySelector("[data-skills-new]")!.dispatch("click"); expect(f.actions.beginCreate).toHaveBeenCalledOnce();
  f.view.render({ ...snapshot, skill: null, creating: true, name: "New name", description: "New description", draft: "New content", dirty: true });
  expect(f.root.querySelector("[data-skills-saved-metadata]")!.hidden).toBe(true);
  expect(f.root.querySelector("[data-skills-creation-fields]")!.hidden).toBe(false);
  const name = f.root.querySelector("[data-skills-new-name]")!; expect(name.disabled).toBe(false);
  expect(name.attributes.get("maxlength")).toBe("160"); name.value = "Changed name"; name.dispatch("input");
  expect(f.actions.setCreationField).toHaveBeenCalledExactlyOnceWith("name", "Changed name");
  const description = f.root.querySelector("[data-skills-new-description]")!;
  expect(description.attributes.get("maxlength")).toBe("512"); description.value = "Changed description"; description.dispatch("input");
  expect(f.actions.setCreationField).toHaveBeenLastCalledWith("description", "Changed description");
  expect(f.root.querySelector("[data-skills-save]")!.textContent).toBe("Create Skill");
  expect(f.root.querySelector("[data-skills-archive]")!.hidden).toBe(true);
  expect(f.root.querySelector("[data-skills-reload]")!.hidden).toBe(true);
  f.root.querySelector("[data-skills-cancel]")!.dispatch("click"); expect(f.actions.cancelCreate).toHaveBeenCalledOnce();
  f.view.render(snapshot);
  expect(f.root.querySelector("[data-skills-new-name]")!.disabled).toBe(true);
  expect(f.root.querySelector("[data-skills-new-description]")!.disabled).toBe(true);
  expect(f.root.querySelector("[data-skills-saved-metadata]")!.hidden).toBe(false);
});
