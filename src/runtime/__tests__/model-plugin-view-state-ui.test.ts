import { describe, expect, test, vi } from "vitest";
// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { createModelPluginViewState } from "../../web-ui/app/components/config-workspace/model-plugin-view-state.js";

type Disclosure = {
  dataset: Record<string, string>;
  open: boolean;
  isConnected: boolean;
};
function disclosure(dataset: Record<string, string>, open = true): Disclosure {
  return { dataset, open, isConnected: true };
}
function control(dataset: Record<string, string>, parentElement?: Disclosure) {
  const node = {
    dataset,
    parentElement,
    tagName: parentElement ? "SUMMARY" : "INPUT",
    disabled: false,
    hidden: false,
    inert: false,
    isConnected: true,
    rendered: true,
    focus: vi.fn(),
    closest: (selector: string) =>
      selector.includes("[hidden]") && (node.hidden || node.inert)
        ? node
        : null,
    getClientRects: () => (node.rendered ? [{}] : []),
  };
  return node;
}
function parentControl(modelId = "first") {
  return control({
    configAction: "model-plugin-enabled",
    id: modelId,
    pluginId: "files",
  });
}
function childControl(modelId = "first", capabilityId = "read") {
  return control({
    configAction: "model-plugin-capability-enabled",
    id: modelId,
    pluginId: "files",
    capabilityId,
  });
}
function fixture() {
  const nodes: {
    details: Disclosure[];
    controls: ReturnType<typeof control>[];
  } = { details: [], controls: [] };
  const ownerDocument: { activeElement: unknown } = { activeElement: null };
  const viewport = { scrollTop: 360, isConnected: true };
  const root = {
    ownerDocument,
    querySelectorAll: (selector: string) =>
      selector.startsWith("details") ? nodes.details : nodes.controls,
    contains: (element: unknown) =>
      nodes.controls.includes(element as ReturnType<typeof control>),
    closest: () => viewport,
  };
  const state = createModelPluginViewState(root);
  return { nodes, ownerDocument, viewport, state };
}

describe("model plugin view state", () => {
  test("scopes disclosures to the model, preserves inner state on outer close, and resets every kind", () => {
    const f = fixture();
    const firstSection = disclosure({ modelPluginSection: "first" });
    const secondSection = disclosure({ modelPluginSection: "second" });
    const firstPlugin = disclosure({
      modelId: "first",
      modelPluginDetails: "files",
    });
    const secondPlugin = disclosure({
      modelId: "second",
      modelPluginDetails: "files",
    });
    const firstRules = disclosure({ modelPluginRetained: "first" });
    const secondRules = disclosure({ modelPluginRetained: "second" });
    f.nodes.details = [
      firstSection,
      secondSection,
      firstPlugin,
      secondPlugin,
      firstRules,
      secondRules,
    ];
    f.state.capture();
    firstSection.open = false;
    firstRules.open = false;
    f.state.remember(firstSection);
    f.state.remember(firstRules);
    expect([...f.state.expandedSections]).toEqual(["second"]);
    expect([...f.state.expandedRetainedRules]).toEqual(["second"]);
    expect([...f.state.expandedPlugins]).toEqual([
      JSON.stringify(["first", "files"]),
      JSON.stringify(["second", "files"]),
    ]);
    f.state.reset();
    expect(f.state.expandedSections.size).toBe(0);
    expect(f.state.expandedPlugins.size).toBe(0);
    expect(f.state.expandedRetainedRules.size).toBe(0);
  });

  test("captures native open state before redraw and ignores delayed toggle events from detached nodes", () => {
    const f = fixture();
    const original = disclosure({
      modelId: "first",
      modelPluginDetails: "files",
    });
    f.nodes.details = [original];
    f.state.capture();
    const key = JSON.stringify(["first", "files"]);
    expect(f.state.expandedPlugins.has(key)).toBe(true);
    const replacement = disclosure({ ...original.dataset });
    f.nodes.details = [replacement];
    original.isConnected = false;
    original.open = false;
    f.state.remember(original);
    expect(f.state.expandedPlugins.has(key)).toBe(true);
    replacement.open = false;
    f.state.remember(replacement);
    expect(f.state.expandedPlugins.has(key)).toBe(false);
    expect(() => f.state.remember({})).not.toThrow();
  });

  test("restores the same model tool and viewport once, independent of a parent control named like the capability", () => {
    const f = fixture();
    const original = childControl("first", "parent");
    f.nodes.controls = [original];
    f.ownerDocument.activeElement = original;
    f.state.capture();
    const parent = parentControl();
    const otherModel = childControl("second", "parent");
    const replacement = childControl("first", "parent");
    f.nodes.controls = [parent, otherModel, replacement];
    f.viewport.scrollTop = 0;
    f.state.restore();
    expect(replacement.focus).toHaveBeenCalledExactlyOnceWith({
      preventScroll: true,
    });
    expect(parent.focus).not.toHaveBeenCalled();
    expect(otherModel.focus).not.toHaveBeenCalled();
    expect(f.viewport.scrollTop).toBe(360);
    f.viewport.scrollTop = 22;
    f.state.restore();
    expect(replacement.focus).toHaveBeenCalledOnce();
    expect(f.viewport.scrollTop).toBe(22);
  });

  test("summary identity uses disclosure kind and model identity rather than dataset order or extra metadata", () => {
    const f = fixture();
    const original = control(
      {},
      disclosure({
        modelPluginDetails: "files",
        modelId: "first",
        unrelated: "old",
      }),
    );
    f.nodes.controls = [original];
    f.ownerDocument.activeElement = original;
    f.state.capture();
    const otherModel = control(
      {},
      disclosure({ modelPluginDetails: "files", modelId: "second" }),
    );
    const replacement = control(
      {},
      disclosure({
        unrelated: "new",
        modelId: "first",
        modelPluginDetails: "files",
      }),
    );
    f.nodes.controls = [otherModel, replacement];
    f.state.restore();
    expect(replacement.focus).toHaveBeenCalledOnce();
    expect(otherModel.focus).not.toHaveBeenCalled();

    const section = control({}, disclosure({ modelPluginSection: "first" }));
    f.nodes.controls = [section];
    f.ownerDocument.activeElement = section;
    f.state.capture();
    const rules = control({}, disclosure({ modelPluginRetained: "first" }));
    const replacementSection = control(
      {},
      disclosure({ modelPluginSection: "first" }),
    );
    f.nodes.controls = [rules, replacementSection];
    f.state.restore();
    expect(rules.focus).not.toHaveBeenCalled();
    expect(replacementSection.focus).toHaveBeenCalledOnce();
  });

  test.each([
    "absent",
    "disabled",
    "hidden",
    "inert",
    "detached",
    "not-rendered",
  ])(
    "consumes focus without restoring or retaining a stale target when it is %s",
    (condition) => {
      const f = fixture();
      const original = parentControl();
      f.nodes.controls = [original];
      f.ownerDocument.activeElement = original;
      f.state.capture();
      const replacement = parentControl();
      if (condition === "disabled") replacement.disabled = true;
      if (condition === "hidden") replacement.hidden = true;
      if (condition === "inert") replacement.inert = true;
      if (condition === "detached") replacement.isConnected = false;
      if (condition === "not-rendered") replacement.rendered = false;
      f.nodes.controls = condition === "absent" ? [] : [replacement];
      f.viewport.scrollTop = 14;
      f.state.restore();
      expect(replacement.focus).not.toHaveBeenCalled();
      expect(f.viewport.scrollTop).toBe(14);
      const later = parentControl();
      f.nodes.controls = [later];
      f.state.restore();
      expect(later.focus).not.toHaveBeenCalled();
      expect(f.viewport.scrollTop).toBe(14);
    },
  );

  test("does not carry pending focus through reset or capture of an unrelated active element", () => {
    const f = fixture();
    const original = parentControl();
    f.nodes.controls = [original];
    f.ownerDocument.activeElement = original;
    f.state.capture();
    f.state.reset();
    f.state.restore();
    expect(original.focus).not.toHaveBeenCalled();
    f.state.capture();
    f.ownerDocument.activeElement = { dataset: { unrelated: "control" } };
    f.state.capture();
    f.state.restore();
    expect(original.focus).not.toHaveBeenCalled();
  });

  test("does not scroll a detached viewport after restoring the same visible control", () => {
    const f = fixture();
    const original = parentControl();
    f.nodes.controls = [original];
    f.ownerDocument.activeElement = original;
    f.state.capture();
    f.viewport.isConnected = false;
    f.viewport.scrollTop = 9;
    const replacement = parentControl();
    f.nodes.controls = [replacement];
    f.state.restore();
    expect(replacement.focus).toHaveBeenCalledOnce();
    expect(f.viewport.scrollTop).toBe(9);
  });
});
