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
      readAppFile("styles/20-chat-composer.css"),
    );

    expect(
      rootRuleDeclarations(stylesheet, ".runtime-setup-guide"),
    ).toMatchObject({
      "align-self": "stretch",
      "justify-self": "stretch",
      width: "100%",
      "min-width": "0",
      "min-height": "0",
      "overflow-x": "hidden",
      "overflow-y": "auto",
      "overscroll-behavior": "contain",
      "scrollbar-gutter": "stable",
    });
    expect(
      rootRuleDeclarations(stylesheet, ".runtime-setup-card"),
    ).toMatchObject({
      width: "min(100%, 820px)",
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
    expect(setupRegion).toContain('aria-label="Runtime setup guide"');
    expect(setupRegion).toContain('tabindex="0"');
  });
});
