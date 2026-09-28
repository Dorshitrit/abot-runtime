import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import postcss, { type Root } from "postcss";
import { describe, expect, test } from "vitest";

const appDirectory = fileURLToPath(
  new URL("../../web-ui/app/", import.meta.url),
);

function readAppFile(path: string): string {
  return readFileSync(`${appDirectory}${path}`, "utf8");
}

function rootRuleDeclarations(root: Root, selector: string) {
  const declarations = new Map<string, string>();
  root.nodes.forEach((node) => {
    if (node.type !== "rule" || node.selector !== selector) return;
    node.walkDecls((declaration) => {
      declarations.set(declaration.prop, declaration.value);
    });
  });
  return Object.fromEntries(declarations);
}

describe("web ui runtime setup layout", () => {
  test("keeps the setup guide scrollable inside the conversation viewport", () => {
    const stylesheet = postcss.parse(
      readAppFile("styles/19-runtime-setup.css"),
    );

    expect(
      rootRuleDeclarations(stylesheet, ".runtime-setup-guide"),
    ).toMatchObject({
      "align-items": "flex-start",
      width: "100%",
      "min-width": "0",
      "min-height": "0",
      "overflow-x": "hidden",
      "overflow-y": "auto",
      "overscroll-behavior": "contain",
      "scrollbar-gutter": "stable",
    });
    expect(
      rootRuleDeclarations(stylesheet, ".runtime-setup-panel"),
    ).toMatchObject({
      width: "min(100%, 560px)",
      "min-width": "0",
    });
    expect(
      rootRuleDeclarations(stylesheet, ".runtime-setup-guide:focus-visible"),
    ).toHaveProperty("outline");
  });

  test("makes the scroll region keyboard reachable and identifiable", () => {
    const document = readAppFile("index.html");
    const setupRegion = document.match(
      /<section\s+[^>]*id="runtimeSetupGuide"[^>]*>/,
    )?.[0];

    expect(setupRegion).toBeDefined();
    expect(setupRegion).toMatch(/aria-label="[^"]+"/);
    expect(setupRegion).toContain('tabindex="0"');
  });
  test("gives Home one content scroll owner while the composer stays pinned below it", () => {
    const setup = postcss.parse(readAppFile("styles/19-runtime-setup.css"));
    const home = postcss.parse(readAppFile("styles/18-dashboard.css"));
    expect(rootRuleDeclarations(home, ".home-workspace-panel")).toMatchObject({
      overflow: "hidden",
      "min-height": "0",
    });
    expect(rootRuleDeclarations(home, ".home-workspace-body")).toMatchObject({
      overflow: "hidden",
      "min-height": "0",
    });
    const content = rootRuleDeclarations(home, ".home-workspace-content");
    expect(content).toMatchObject({
      flex: "1",
      "min-height": "0",
      "overflow-y": "auto",
      "overscroll-behavior": "contain",
    });
    expect(content).not.toHaveProperty("overflow");
    const composer = rootRuleDeclarations(home, ".home-workspace-start");
    expect(composer).toMatchObject({ flex: "none" });
    expect(composer).not.toHaveProperty("position");
    expect(composer).not.toHaveProperty("overflow");
    expect(composer).not.toHaveProperty("overflow-y");
    expect(
      rootRuleDeclarations(home, ".home-setup-active .home-workspace-start"),
    ).toMatchObject({ display: "none" });
    expect(
      rootRuleDeclarations(setup, ".home-setup-host .runtime-setup-guide"),
    ).toMatchObject({ overflow: "visible", padding: "0" });
    expect(
      rootRuleDeclarations(setup, ".home-setup-active .home-workspace-start"),
    ).toMatchObject({ "margin-top": "0" });
    const panel = rootRuleDeclarations(setup, ".runtime-setup-panel");
    expect(panel).not.toHaveProperty("height");
    expect(panel).not.toHaveProperty("max-height");
    expect(
      rootRuleDeclarations(setup, ".runtime-setup-footer"),
    ).not.toHaveProperty("position");
  });

  test("keeps a fluid form, shrinkable fields and reachable actions at phone widths", () => {
    const setup = postcss.parse(readAppFile("styles/19-runtime-setup.css"));
    expect(
      rootRuleDeclarations(setup, ".runtime-setup-field input"),
    ).toMatchObject({ width: "100%", "min-width": "0", "min-height": "44px" });
    expect(rootRuleDeclarations(setup, ".runtime-setup-content")).toMatchObject(
      { "min-width": "0" },
    );
    expect(
      rootRuleDeclarations(setup, ".runtime-setup-result dd"),
    ).toMatchObject({ "overflow-wrap": "anywhere" });
    const phoneRules = setup.nodes.find(
      (node) =>
        node.type === "atrule" &&
        node.name === "media" &&
        node.params === "(max-width: 520px)",
    );
    expect(phoneRules?.type).toBe("atrule");
    if (phoneRules?.type !== "atrule") return;
    const selectors = phoneRules.nodes
      ?.filter((node) => node.type === "rule")
      .map((node) => (node.type === "rule" ? node.selector : ""));
    expect(selectors).toEqual(
      expect.arrayContaining([
        ".runtime-setup-guide",
        ".runtime-setup-panel",
        ".runtime-setup-progress",
        ".runtime-setup-footer",
      ]),
    );
    expect(readAppFile("styles.css")).toContain(
      "./styles/19-runtime-setup.css",
    );
  });
  test("fits five progress steps on phones and leaves plugin cards in the outer scroll flow", () => {
    const setup = postcss.parse(readAppFile("styles/19-runtime-setup.css"));
    expect(
      rootRuleDeclarations(setup, ".runtime-setup-progress"),
    ).toMatchObject({
      display: "grid",
      "grid-template-columns": "repeat(5, minmax(0, 1fr))",
    });
    const rules: Record<string, string>[] = [];
    setup.walkRules(".runtime-setup-progress-label", (rule) => {
      if (rule.parent?.type !== "atrule") return;
      const declarations: Record<string, string> = {};
      rule.walkDecls((declaration) => {
        declarations[declaration.prop] = declaration.value;
      });
      rules.push(declarations);
    });
    expect(rules).toContainEqual(
      expect.objectContaining({
        "clip-path": "inset(50%)",
        position: "absolute",
      }),
    );
    const plugins = postcss.parse(
      readAppFile("styles/42-runtime-setup-plugins.css"),
    );
    for (const selector of [
      ".runtime-plugin-list",
      ".runtime-plugin-capabilities",
    ]) {
      const declarations: Record<string, string> = {};
      plugins.walkRules((rule) => {
        if (rule.parent?.type !== "root" || !rule.selectors.includes(selector))
          return;
        rule.walkDecls((declaration) => {
          declarations[declaration.prop] = declaration.value;
        });
      });
      expect(Object.keys(declarations).length).toBeGreaterThan(0);
      expect(declarations).not.toHaveProperty("height");
      expect(declarations).not.toHaveProperty("max-height");
      expect(declarations).not.toHaveProperty("overflow-y");
    }
    for (const path of [
      "components/runtime-setup/embedding-rendering.js",
      "components/runtime-setup/plugins.js",
    ])
      expect(readAppFile(path)).not.toContain("<form");
  });
});
