import { describe, expect, it } from "vitest";
// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { createAutomationsWorkspace } from "../../web-ui/app/components/automations/workspace.js";
// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { createAutomationLiveView } from "../../web-ui/app/components/automations/live-view.js";
// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { renderAutomationStepEvidence } from "../../web-ui/app/components/automations/run-report-view.js";
import { FakeElement } from "./support/model-setup-wizard-harness.js";

function fixture() {
  const document = { activeElement: null } as ConstructorParameters<typeof FakeElement>[1];
  document.createElement = (tag) => new FakeElement(tag, document);
  document.documentElement = document.createElement("html");
  document.body = document.createElement("body");
  const root = document.createElement("section");
  Object.defineProperty(root, "firstChild", { get: () => root.children[0] });
  const html = Object.getOwnPropertyDescriptor(FakeElement.prototype, "innerHTML")!;
  Object.defineProperty(root, "innerHTML", {
    get: () => html.get!.call(root),
    set(value: string) {
      html.set!.call(root, value);
      root.scrollTop = 0;
      for (const node of root.querySelectorAll("*"))
        Object.assign(node, { getAttribute: (name: string) => node.attributes.get(name) ?? null });
    },
  });
  document.body.append(root);
  return { document, root };
}

const definition = {
  schemaVersion: 1, automationId: "auto-one", revision: 1, title: "Daily brief",
  objective: "Summarize", inputs: {}, trigger: { kind: "manual" }, limits: {},
  body: { kind: "sequence", id: "root", children: [{ kind: "agent", id: "summarize",
    title: "Summarize", modelProfileId: "local", agentMode: "fast", onFailure: "stop",
    prompt: "Summarize the input", roleInstructions: "", inputs: {}, tools: [], result: { kind: "text" } }] },
};

function snapshot() {
  return { automations: [{ id: "auto-one", status: "active", title: "Daily brief" }],
    selectedAutomationId: "auto-one", selectedRunId: "", selectedNodeId: "", runs: [],
    draft: { revision: 1, definition }, publishedDefinition: null,
    catalog: { operations: [], models: [], savedAgents: [] }, grant: null, validation: null,
    error: "", feedback: "", loading: false, mutation: "" };
}

describe("automation live view continuity", () => {
  it("leaves the editor input and cursor in place on an unchanged background snapshot", () => {
    const { document, root } = fixture();
    const current = snapshot();
    const workspace = createAutomationsWorkspace({ root, documentRoot: document,
      actions: { snapshot: () => current } });
    const input = root.querySelector('[name="title"]')!;
    expect(input).not.toBeNull();
    input.value = "Unsaved typing";
    input.focus();
    root.scrollTop = 340;
    const disclosure = root.querySelector("details")!;
    disclosure.setAttribute("open", "");
    disclosure.open = true;
    workspace.render(structuredClone(current));
    expect(root.querySelector('[name="title"]')).toBe(input);
    expect(input.value).toBe("Unsaved typing");
    expect(document.activeElement).toBe(input);
    expect(root.scrollTop).toBe(340);
    expect(root.querySelector("details")).toBe(disclosure);
    expect(disclosure.open).toBe(true);
  });

  it("preserves scroll, focus and disclosures when the same live run gains new evidence", () => {
    const { root, document } = fixture();
    const live = createAutomationLiveView(root);
    const markup = (text: string) => `<section><button id="stop">Stop run</button><details data-disclosure-id="diagnostics"><summary>Diagnostics</summary><pre>${text}</pre></details></section>`;
    live.update("auto-one/run-one", markup("First result"));
    root.scrollTop = 600;
    const diagnostics = root.querySelector("details")!;
    diagnostics.setAttribute("open", "");
    diagnostics.open = true;
    root.querySelector("pre")!.scrollTop = 150;
    root.querySelector("button")!.focus();
    expect(live.update("auto-one/run-one", markup("Second result"))).toBe(true);
    expect(root.scrollTop).toBe(600);
    expect(root.querySelector("details")?.open).toBe(true);
    expect(root.querySelector("pre")?.scrollTop).toBe(150);
    expect(document.activeElement).toBe(root.querySelector("button"));
    expect(root.textContent).toContain("Second result");
    const retained = root.querySelector("pre");
    expect(live.update("auto-one/run-one", markup("Second result"))).toBe(false);
    expect(root.querySelector("pre")).toBe(retained);
  });

  it("resets local view state when navigating to another run with identical markup", () => {
    const { root } = fixture();
    const live = createAutomationLiveView(root);
    const markup = `<details><summary>Diagnostics</summary><pre>Saved output</pre></details>`;
    live.update("auto-one/run-one", markup);
    root.scrollTop = 500;
    root.querySelector("pre")!.scrollTop = 90;
    root.querySelector("details")!.setAttribute("open", "");
    expect(live.update("auto-one/run-two", markup)).toBe(true);
    expect(root.scrollTop).toBe(0);
    expect(root.querySelector("pre")?.scrollTop).toBe(0);
    expect(root.querySelector("details")?.open).toBe(false);
  });

  it("keeps the run view position when an event changes a node status", () => {
    const { document, root } = fixture();
    const current = { ...snapshot(), selectedRunId: "run-one", selectedNodeId: "summarize", run: {
      id: "run-one", definition, status: "running", nodes: [{ nodeId: "summarize", status: "running" }],
    } };
    const workspace = createAutomationsWorkspace({ root, documentRoot: document,
      actions: { snapshot: () => current } });
    root.scrollTop = 280;
    const viewport = root.querySelector(".automation-run-detail")!;
    viewport.scrollTop = 190;
    Object.assign(viewport, { scrollLeft: 75 });
    workspace.render({ ...current, run: { ...current.run,
      nodes: [{ nodeId: "summarize", status: "succeeded" }] } });
    expect(root.scrollTop).toBe(280);
    expect(root.querySelector(".automation-run-detail")?.scrollTop).toBe(190);
    expect((root.querySelector(".automation-run-detail") as FakeElement & { scrollLeft: number }).scrollLeft).toBe(75);
    expect(root.textContent).toContain("succeeded");
  });

  it("keeps the current output visible while loading full evidence or reporting a read failure", () => {
    const state = { selectedNodeId: "summarize", run: { id: "run-one" },
      stepEvidenceLoading: true, stepEvidenceError: "", stepEvidence: {
        runId: "run-one", nodeId: "summarize", availability: "available", inputs: [], effects: [],
        output: { text: { value: "Saved preview", truncated: true }, full: false },
      } };
    expect(renderAutomationStepEvidence(state)).toContain("Saved preview");
    expect(renderAutomationStepEvidence(state)).not.toContain("Loading saved evidence");
    const failure = renderAutomationStepEvidence({ ...state, stepEvidenceLoading: false,
      stepEvidenceError: "Unable to refresh saved output" });
    expect(failure).toContain("Saved preview");
    expect(failure).toContain('role="alert"');
    expect(failure).toContain("Unable to refresh saved output");
    expect(renderAutomationStepEvidence({ ...state, selectedNodeId: "another" })).not.toContain("Saved preview");
  });
});
