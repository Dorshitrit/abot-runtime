import { describe, expect, test } from "vitest";
import { FakeElement } from "./support/model-setup-wizard-harness.js";
// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { renderAutomationTemplateGallery } from "../../web-ui/app/components/automations/template-gallery.js";

function gallery(templates: Array<Record<string, unknown>>) {
  const document = {} as ConstructorParameters<typeof FakeElement>[1];
  const root = new FakeElement("div", document);
  root.innerHTML = renderAutomationTemplateGallery({ templateCatalog: { templates } });
  return root;
}

const starter = { id: "health", title: "Machine health", category: "System",
  description: "Inspect the machine and explain the result.", stepCount: 2,
  agentCount: 1, toolNames: ["system_probe"] };
const advanced = { id: "research", title: "Research desk", category: "Research",
  level: "advanced", description: "Gather evidence, compare perspectives, and save a brief.",
  stepCount: 8, agentCount: 3, parallelGroupCount: 1,
  highlights: ["Parallel perspectives", "Bound inputs from earlier steps"],
  outputFiles: ["brief.md", "evidence.json"], toolNames: ["web_search", "write_file"],
  setup: "Choose a model and a working directory." };

describe("automation template gallery", () => {
  test("presents complete workflows first with truthful counts and learning outcomes", () => {
    const root = gallery([starter, advanced]);
    const sections = root.querySelectorAll(".automation-template-section");
    expect(sections).toHaveLength(2);
    expect(sections[0]!.attributes.get("aria-labelledby")).toBe("automation-templates-advanced-title");
    expect(sections[1]!.attributes.get("aria-labelledby")).toBe("automation-templates-starter-title");
    expect(root.querySelector(".automation-template-count")!.textContent).toBe("2 available");
    const card = sections[0]!.querySelector('[data-template-id="research"]')!;
    expect(card.attributes.get("aria-label")).toBe("Use Research desk template");
    expect(card.querySelector(".automation-template-facts")!.textContent).toBe("8 steps3 agents1 parallel group");
    expect(card.querySelectorAll(".automation-template-detail-item").map((item) => item.textContent))
      .toEqual([...advanced.highlights, ...advanced.outputFiles]);
    expect(card.querySelector(".automation-template-setup")!.textContent).toContain(advanced.setup);
    expect(root.querySelectorAll("button")).toHaveLength(2);
    expect(card.querySelectorAll("button")).toHaveLength(0);
    expect(card.querySelectorAll("a")).toHaveLength(0);
  });

  test("omits empty sections and keeps older or unknown metadata usable", () => {
    const root = gallery([{ ...starter, agentCount: undefined },
      { ...starter, id: "unknown", level: "future", highlights: {}, outputFiles: null,
        toolNames: "not-an-array", agentCount: -1, parallelGroupCount: "many" }]);
    expect(root.querySelectorAll(".automation-template-section")).toHaveLength(1);
    expect(root.querySelector('[id="automation-templates-advanced-title"]')).toBeNull();
    const legacy = root.querySelector('[data-template-id="health"]')!;
    expect(legacy.querySelector(".automation-template-facts")!.textContent).toBe("2 steps");
    const unknown = root.querySelector('[data-template-id="unknown"]')!;
    expect(unknown.querySelector(".automation-template-facts")!.textContent).toBe("2 steps");
    expect(unknown.querySelector(".automation-template-detail")).toBeNull();
    expect(unknown.querySelector(".automation-template-tools")!.textContent).toBe("");
    expect(gallery([advanced]).querySelector('[id="automation-templates-starter-title"]')).toBeNull();
  });

  test("escapes catalog text and attribute values without adding executable markup", () => {
    const dangerous = '<img src="x" onerror="bad()">';
    const id = 'custom" onclick="bad()';
    const root = gallery([{ ...advanced, id, title: dangerous, category: dangerous,
      description: dangerous, setup: dangerous, highlights: [dangerous, null, {}],
      outputFiles: [dangerous], toolNames: [dangerous] }]);
    const card = root.querySelector("button")!;
    expect(card.attributes.get("data-template-id")).toBe(id);
    expect(card.attributes.get("aria-label")).toBe(`Use ${dangerous} template`);
    expect(card.attributes.has("onclick")).toBe(false);
    expect(root.querySelector("img")).toBeNull();
    expect(card.querySelectorAll(".automation-template-detail-item").map((item) => item.textContent))
      .toEqual([dangerous, dangerous]);
    expect(card.querySelector(".automation-template-description")!.textContent).toBe(dangerous);
  });

  test("keeps loading, empty, and failure states outside workflow sections", () => {
    expect(renderAutomationTemplateGallery({})).toContain("Finding templates");
    expect(gallery([]).querySelectorAll(".automation-template-section")).toHaveLength(0);
    expect(gallery([]).querySelector(".automation-template-empty")!.textContent).toContain("No templates match");
    const markup = renderAutomationTemplateGallery({ templateCatalog: { templates: [] },
      templateCatalogError: "Catalog <unavailable>" });
    expect(markup).toContain("Catalog &lt;unavailable&gt;");
  });
});
