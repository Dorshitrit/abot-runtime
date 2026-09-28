import { describe, expect, test, vi } from "vitest";
// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { createStartupScreen } from "../../web-ui/app/components/startup-screen.js";

class StartupElement extends EventTarget {
  hidden = false;
  inert = false;
  textContent = "";
  dataset: Record<string, string> = {};
  attributes = new Map<string, string>();
  focus = vi.fn();

  setAttribute(name: string, value: string) {
    if (name === "data-startup-pending") this.dataset.startupPending = value;
    if (name === "inert") this.inert = true;
    this.attributes.set(name, value);
  }

  removeAttribute(name: string) {
    if (name === "data-startup-pending") delete this.dataset.startupPending;
    if (name === "inert") this.inert = false;
    this.attributes.delete(name);
  }

  getAttribute(name: string) {
    if (name === "data-startup-pending") return this.dataset.startupPending ?? null;
    if (name === "inert") return this.inert ? "" : null;
    return this.attributes.get(name) ?? null;
  }

  hasAttribute(name: string) {
    return this.getAttribute(name) !== null;
  }
}

function createHarness() {
  const elements = {
    app: new StartupElement(),
    appStartup: new StartupElement(),
    startupStatus: new StartupElement(),
    startupRetry: new StartupElement(),
  };
  elements.app.setAttribute("data-startup-pending", "");
  elements.app.setAttribute("inert", "");
  elements.app.setAttribute("aria-busy", "true");
  elements.startupStatus.textContent = "Loading";
  elements.startupRetry.hidden = true;
  const reload = vi.fn();
  const documentRoot = {
    getElementById(id: keyof typeof elements) { return elements[id]; },
  };
  const screen = createStartupScreen({ documentRoot, reload });
  return { ...elements, screen, reload };
}

function expectWorkspacePending(app: StartupElement) {
  expect(app.hasAttribute("data-startup-pending")).toBe(true);
  expect(app.inert).toBe(true);
}

describe("Web UI startup screen", () => {
  test("keeps the workspace inaccessible while bootstrap is pending", () => {
    const f = createHarness();
    expectWorkspacePending(f.app);
    expect(f.app.getAttribute("aria-busy")).toBe("true");
    expect(f.appStartup.hidden).toBe(false);
    expect(f.startupRetry.hidden).toBe(true);
    expect(f.reload).not.toHaveBeenCalled();
  });

  test("reveals the workspace and removes its loading state only when ready is signaled", () => {
    const f = createHarness();
    f.screen.ready();
    expect(f.app.hasAttribute("data-startup-pending")).toBe(false);
    expect(f.app.inert).toBe(false);
    expect(f.app.getAttribute("aria-busy")).not.toBe("true");
    expect(f.appStartup.hidden).toBe(true);
    expect(f.reload).not.toHaveBeenCalled();
  });

  test("keeps failed bootstrap behind an actionable error screen without automatically retrying", () => {
    const f = createHarness();
    f.screen.fail(new Error("Configuration could not load"));
    expectWorkspacePending(f.app);
    expect(f.appStartup.hidden).toBe(false);
    expect(f.startupStatus.getAttribute("role")).toBe("alert");
    expect(f.app.getAttribute("aria-busy")).toBe("true");
    expect(f.startupStatus.textContent).toContain("Configuration could not load");
    expect(f.startupStatus.textContent.trim()).not.toBe("");
    expect(f.startupStatus.textContent).not.toBe("[object Object]");
    expect(f.startupRetry.hidden).toBe(false);
    expect(f.reload).not.toHaveBeenCalled();
    f.startupRetry.dispatchEvent(new Event("click"));
    expect(f.reload).toHaveBeenCalledOnce();
  });

  test("repeated error presentation does not duplicate the explicit retry action", () => {
    const f = createHarness();
    f.screen.fail(new Error("First load failed"));
    f.screen.fail(new Error("Second load failed"));
    expect(f.reload).not.toHaveBeenCalled();
    f.startupRetry.dispatchEvent(new Event("click"));
    expect(f.reload).toHaveBeenCalledOnce();
  });
});
