import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

const appUrl = new URL("../../web-ui/app/", import.meta.url);
const stylesUrl = new URL("styles/", appUrl);
const markup = readFileSync(new URL("index.html", appUrl), "utf8");
const responsiveStyles = readFileSync(
  new URL("90-responsive.css", stylesUrl),
  "utf8",
);
const scrollbarOwner = readFileSync(
  new URL("00-tokens-base.css", stylesUrl),
  "utf8",
);
const allStyles = readdirSync(fileURLToPath(stylesUrl))
  .filter((name) => name.endsWith(".css"))
  .map((name) => readFileSync(new URL(name, stylesUrl), "utf8"))
  .join("\n");

describe("web ui shell presentation", () => {
  test("uses the single conversations control as the rail-leading action", () => {
    expect(markup.match(/id="sessionsToggleButton"/g)).toHaveLength(1);
    expect(markup).not.toContain('class="rail-brand"');
    expect(markup.indexOf('id="sessionsToggleButton"')).toBeLessThan(
      markup.indexOf('class="rail-actions"'),
    );
    expect(markup).toContain('aria-controls="sessionsPanel"');
    expect(markup).toContain('aria-expanded="false"');
  });

  test("keeps environment and connection state in one rail status component", () => {
    const statusComponent = markup.match(
      /<div class="rail-runtime">([\s\S]*?)<\/nav>/,
    )?.[1];
    expect(statusComponent).toContain('id="agentPickerButton"');
    expect(statusComponent).toContain('id="connectionLabel"');
    expect(statusComponent).toContain('role="status"');
    expect(statusComponent).toContain('aria-live="polite"');
  });

  test("keeps all five mobile destinations visible", () => {
    expect(responsiveStyles).toMatch(
      /\.workspace-rail\s*\{[\s\S]*?grid-template-columns:\s*repeat\(5,/,
    );
    expect(responsiveStyles).toMatch(
      /\.rail-actions\s*\{\s*display:\s*contents;/,
    );
    expect(responsiveStyles).toContain(".rail-history-button");
  });

  test("owns discoverable Firefox and WebKit scrollbars centrally", () => {
    expect(scrollbarOwner).toContain("scrollbar-width: thin");
    expect(scrollbarOwner).toContain("scrollbar-color:");
    expect(scrollbarOwner).toContain("::-webkit-scrollbar-thumb:hover");
    expect(allStyles).not.toMatch(/scrollbar-width:\s*none/);
    expect(allStyles).not.toMatch(
      /::-webkit-scrollbar\s*\{[^}]*display:\s*none/,
    );
  });
});
