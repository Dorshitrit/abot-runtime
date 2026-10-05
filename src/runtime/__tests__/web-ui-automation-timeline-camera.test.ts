import { describe, expect, test, vi } from "vitest";
// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { renderAutomationTimeline } from "../../web-ui/app/components/automations/timeline.js";
// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { createAutomationsWorkspace } from "../../web-ui/app/components/automations/workspace.js";
// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { canPanFromCanvasTarget, createAutomationTimelineCamera, wheelZoomLevel } from "../../web-ui/app/components/automations/timeline-camera.js";
// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { canWrapAutomationSequence, VALID_PARALLEL_LEVELS } from "../../web-ui/app/lib/automation-parallel-depth.js";
import { AUTOMATION_GRAPH_LIMITS } from "../automations/limits.js";
import { FakeElement } from "./support/model-setup-wizard-harness.js";

function step(id: string) {
  return { kind: "agent", id, title: id, modelProfileId: "local", agentMode: "fast",
    onFailure: "stop", prompt: "Run", roleInstructions: "", inputs: {}, tools: [], result: { kind: "text" } };
}

function nestedDefinition() {
  return { schemaVersion: 1, automationId: "automation-one", revision: 1, title: "Nested workflow",
    objective: "", inputs: {}, trigger: { kind: "manual" }, limits: {},
    body: { kind: "sequence", id: "root", children: [{ kind: "parallel", id: "outer", branches: [
      { kind: "sequence", id: "outer-one", children: [{ kind: "parallel", id: "middle", branches: [
        { kind: "sequence", id: "middle-one", children: [{ kind: "parallel", id: "inner", branches: [
          { kind: "sequence", id: "inner-one", children: [step("deep-one")] },
          { kind: "sequence", id: "inner-two", children: [step("deep-two")] },
        ] }] },
        { kind: "sequence", id: "middle-two", children: [step("peer-one"), step("peer-two")] },
      ] }] },
      { kind: "sequence", id: "outer-two", children: [step("outer-peer")] },
    ] }] },
  };
}

function fakeDocument() {
  const document = {} as ConstructorParameters<typeof FakeElement>[1];
  document.createElement = (tag) => new FakeElement(tag, document);
  document.documentElement = document.createElement("html");
  document.body = document.createElement("body");
  return document;
}

function cameraFixture() {
  const document = fakeDocument();
  const root = document.createElement("section");
  document.body.append(root);
  root.innerHTML = renderAutomationTimeline(nestedDefinition(), { editable: true });
  const viewport = root.querySelector("[data-camera-viewport]")! as FakeElement & { scrollLeft: number };
  const scene = root.querySelector("[data-camera-scene]")!;
  Object.assign(viewport, { clientWidth: 600, clientHeight: 500, scrollLeft: 0,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 600, height: 500 }) });
  const camera = createAutomationTimelineCamera(root);
  camera.restore();
  return { document, root, viewport, scene, camera };
}

describe("ABot Studio timeline camera", () => {
  test("keeps the full graph and exposes wheel, drag, and keyboard guidance", () => {
    const markup = renderAutomationTimeline(nestedDefinition(), { editable: true });
    expect(markup.match(/class="automation-fork"/g)).toHaveLength(3);
    expect(markup).not.toContain("Parallel ·");
    expect(markup).toContain('aria-label="Parallel steps, all branches join before continuing"');
    expect(markup).not.toContain('title="Wheel:');
    expect(markup).toContain('data-automation-node="deep-one"');
    expect(markup).toContain('data-insert-parent="inner-one"');
    expect(markup).toContain('data-scene-min-width="1236"');
    expect(markup).toContain('grid-template-columns:924px 300px');
    expect(markup).toContain('grid-template-columns:612px 300px');
    expect(markup).toContain("Use the mouse wheel or plus and minus keys to zoom");
    expect(markup).not.toContain("data-camera-zoom-out");
    expect(markup).not.toContain("data-zoom-parallel");
  });

  test("anchors wheel zoom under the pointer and bounds it at 65–200%", () => {
    const { viewport, scene, root, camera } = cameraFixture();
    viewport.scrollLeft = 100;
    viewport.scrollTop = 150;
    expect(camera.wheel({ deltaY: -120, deltaMode: 0, clientX: 300, clientY: 200 })).toBe(true);
    const nextZoom = wheelZoomLevel(1, -120);
    expect(viewport.scrollLeft).toBeCloseTo(400 * nextZoom - 300);
    expect(viewport.scrollTop).toBeCloseTo(350 * nextZoom - 200);
    expect(scene.attributes.get("style")).toContain("width:1236px;zoom:");
    expect(root.querySelector("[data-camera-level]")?.textContent).toBe(`${Math.round(nextZoom * 100)}%`);
    expect(wheelZoomLevel(1, -10000)).toBeCloseTo(Math.exp(0.09));
    expect(wheelZoomLevel(1, 10000, 2, 500)).toBeCloseTo(Math.exp(-0.09));
    let repeated = 1;
    for (let index = 0; index < 20; index += 1) repeated = wheelZoomLevel(repeated, -120);
    expect(repeated).toBe(2);
    expect(camera.keyboard({ key: "0" })).toBe(true);
    expect(root.querySelector("[data-camera-level]")?.textContent).toBe("100%");
    expect(viewport.scrollLeft).toBe(0);
  });

  test("locks zoom while a step editor is open and restores controls after closing", () => {
    const { document, root, scene, camera } = cameraFixture();
    const inspectorFrame = document.createElement("div");
    inspectorFrame.className = "automation-inline-inspector-frame";
    scene.append(inspectorFrame);
    expect(camera.wheel({ deltaY: -120, deltaMode: 0, clientX: 300, clientY: 200 })).toBe(false);
    expect(camera.keyboard({ key: "+" })).toBe(false);
    expect(camera.wheel({ deltaY: 120, deltaMode: 0, clientX: 300, clientY: 200 })).toBe(false);
    expect(camera.keyboard({ key: "-" })).toBe(false);
    expect(camera.keyboard({ key: "0" })).toBe(false);
    expect(root.querySelector("[data-camera-level]")?.textContent).toBe("100%");
    expect(camera.keyboard({ key: "=" })).toBe(false);
    inspectorFrame.remove();
    expect(camera.keyboard({ key: "+" })).toBe(true);
    expect(root.querySelector("[data-camera-level]")?.textContent).toBe("120%");
    scene.append(inspectorFrame);
    expect(camera.wheel({ deltaY: 120, deltaMode: 0, clientX: 300, clientY: 200 })).toBe(false);
    expect(camera.keyboard({ key: "-" })).toBe(false);
    expect(camera.keyboard({ key: "0" })).toBe(false);
    expect(root.querySelector("[data-camera-level]")?.textContent).toBe("120%");
    inspectorFrame.remove();
    expect(camera.keyboard({ key: "0" })).toBe(true);
    expect(root.querySelector("[data-camera-level]")?.textContent).toBe("100%");
  });

  test("pans from empty background but leaves nodes, drop targets, and forms interactive", () => {
    const { document, viewport, scene, root, camera } = cameraFixture();
    const node = root.querySelector('[data-automation-node="deep-one"]')!;
    const connector = root.querySelector("[data-insert-parent]")!;
    const form = document.createElement("form");
    const input = document.createElement("input");
    const inspectorFrame = document.createElement("div");
    inspectorFrame.className = "automation-inline-inspector-frame";
    const inspectorWhitespace = document.createElement("div");
    inspectorFrame.append(inspectorWhitespace);
    form.append(input);
    scene.append(form);
    scene.append(inspectorFrame);
    expect(canPanFromCanvasTarget(node)).toBe(false);
    expect(canPanFromCanvasTarget(connector)).toBe(false);
    expect(canPanFromCanvasTarget(input)).toBe(false);
    expect(canPanFromCanvasTarget(inspectorWhitespace)).toBe(false);
    expect(camera.startPan({ target: node, pointerId: 1, button: 0, clientX: 200, clientY: 200 })).toBe(false);
    viewport.scrollLeft = 300;
    viewport.scrollTop = 200;
    expect(camera.startPan({ target: scene, pointerId: 2, button: 0, clientX: 200, clientY: 200 })).toBe(true);
    expect(camera.movePan({ pointerId: 2, clientX: 150, clientY: 170 })).toBe(true);
    expect(viewport.scrollLeft).toBe(350);
    expect(viewport.scrollTop).toBe(230);
    expect(camera.endPan({ pointerId: 2 })).toBe(true);
    expect(viewport.hasAttribute("data-panning")).toBe(false);
  });

  test("keeps an expanded graph on one pannable canvas across rerenders", () => {
    const { root, viewport, camera } = cameraFixture();
    const inner = root.querySelector('[data-branches-for="inner"]')! as FakeElement & {
      scrollLeft: number; scrollWidth: number; clientWidth: number;
    };
    Object.assign(inner, { clientWidth: 612, scrollWidth: 612, clientHeight: 300,
      scrollHeight: 300, scrollLeft: 0 });
    const middle = root.querySelector('[data-branches-for="middle"]')! as FakeElement & {
      scrollLeft: number; scrollWidth: number; clientWidth: number;
    };
    Object.assign(middle, { clientWidth: 924, scrollWidth: 924, scrollLeft: 0 });
    const background = inner.querySelector(".automation-branch-label")!;
    expect(viewport.scrollLeft).toBe(318);
    expect(camera.startPan({ target: background, pointerId: 4, button: 0, clientX: 180, clientY: 180 })).toBe(true);
    expect(camera.movePan({ pointerId: 4, clientX: 130, clientY: 160 })).toBe(true);
    expect(inner.scrollLeft).toBe(0);
    expect(middle.scrollLeft).toBe(0);
    expect(viewport.scrollLeft).toBe(368);
    expect(camera.endPan({ pointerId: 4 })).toBe(true);
    camera.capture();
    root.innerHTML = renderAutomationTimeline(nestedDefinition(), { editable: true });
    const restoredViewport = root.querySelector("[data-camera-viewport]")! as FakeElement & { scrollLeft: number };
    Object.assign(restoredViewport, { clientWidth: 600, clientHeight: 500 });
    camera.restore();
    expect(restoredViewport.scrollLeft).toBe(368);
  });

  test("keeps the graph centered when a branch changes the scene width", () => {
    const { root, viewport, camera } = cameraFixture();
    expect(viewport.scrollLeft).toBe(318);
    camera.capture();
    const compact = { ...nestedDefinition(), body: { kind: "sequence", id: "root", children: [step("only-step")] } };
    root.innerHTML = renderAutomationTimeline(compact, { editable: true });
    const compactViewport = root.querySelector("[data-camera-viewport]")! as FakeElement & { scrollLeft: number };
    Object.assign(compactViewport, { clientWidth: 600, clientHeight: 500 });
    camera.restore();
    expect(compactViewport.scrollLeft).toBe(0);
  });

  test("reveals a selected card that is clipped at the canvas edge", () => {
    const { root, viewport, camera } = cameraFixture();
    const item = root.querySelector('[data-graph-item="peer-one"]')! as FakeElement & {
      getBoundingClientRect: () => { left: number; right: number; width: number };
    };
    item.getBoundingClientRect = () => ({ left: 306, right: 606, width: 300 });
    const outer = root.querySelector('[data-branches-for="outer"]')! as FakeElement & {
      getBoundingClientRect: () => { left: number; right: number; width: number };
    };
    Object.assign(outer, { clientWidth: 1236,
      getBoundingClientRect: () => ({ left: -318, right: 918, width: 1236 }) });
    const middle = root.querySelector('[data-branches-for="middle"]')! as FakeElement & {
      getBoundingClientRect: () => { left: number; right: number; width: number };
    };
    Object.assign(middle, { clientWidth: 924,
      getBoundingClientRect: () => ({ left: -304, right: 620, width: 924 }) });
    Object.assign(viewport, { getBoundingClientRect: () => ({ left: 0, right: 600, top: 0, width: 600, height: 500 }) });
    camera.revealNode("peer-one");
    expect(viewport.scrollLeft).toBe(332);
  });

  test("opens a clicked step immediately at the user's zoom level", () => {
    const document = fakeDocument();
    const root = document.createElement("section");
    document.body.append(root);
    const snapshot = { automations: [{ id: "automation-one", status: "draft" }],
      selectedAutomationId: "automation-one", selectedRunId: "", selectedNodeId: "", runs: [],
      draft: { revision: 1, definition: nestedDefinition() }, publishedDefinition: null,
      catalog: { operations: [], models: [], savedAgents: [] }, grant: null, validation: null,
      error: "", feedback: "", loading: false, mutation: "" };
    let workspace: ReturnType<typeof createAutomationsWorkspace>;
    const actions = { snapshot: () => snapshot, selectNode(id: string) {
      snapshot.selectedNodeId = id;
      workspace.render(snapshot);
    } };
    workspace = createAutomationsWorkspace({ root, documentRoot: document, actions,
      confirmDiscard: () => true });
    root.querySelector('[data-automation-node="deep-one"]')!.dispatch("click");
    expect(snapshot.selectedNodeId).toBe("deep-one");
    expect(root.querySelector("#automation-step-settings")).not.toBeNull();
    expect(root.querySelector("[data-camera-level]")?.textContent).toBe("100%");
    const inspectorFrame = root.querySelector(".automation-inline-inspector-frame")!;
    const inspectorContent = inspectorFrame.querySelector(".automation-inline-inspector-clip")!;
    const preventDefault = vi.fn();
    for (const handler of root.listeners.get("wheel") || [])
      handler({ target: inspectorContent, deltaY: -120, clientX: 100, clientY: 100, preventDefault });
    expect(preventDefault).not.toHaveBeenCalled();
  });

  test("blocks a third nested merge under the runtime depth limit", () => {
    const graph = nestedDefinition().body;
    expect(VALID_PARALLEL_LEVELS * 2).toBe(AUTOMATION_GRAPH_LIMITS.nestingDepth);
    expect(canWrapAutomationSequence(graph, "middle-two")).toBe(false);
    expect(canWrapAutomationSequence(graph, "outer-two")).toBe(true);
  });
});
