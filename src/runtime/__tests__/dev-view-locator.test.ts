import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { DEV_SCAN_BYTES } from "../../../plugins/filesystem/source/bounded-io.js";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import { createDevViewLocatorFixture } from "./support/dev-view-locator-fixture.js";
import { disposeCompositionFixtures } from "./support/runtime-composition-fixture.js";

type LocatorCandidate = {
  matchStartLine: number;
  matchEndLine: number;
  rangeTruncated: boolean;
  nextControls: { path: string; start_line: number; end_line: number };
};

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(async () => {
  await disposeCompositionFixtures();
  resetDebugLoggerConfig();
});

async function viewFixture(content: string) {
  const fixture = await createDevViewLocatorFixture();
  const file = join(fixture.config.paths.agentWorkDir, "notes.txt");
  await writeFile(file, content);
  return { ...fixture, file, view: fixture.plugin.handlers.dev_view! };
}

describe("Dev View ambiguous locator receipts", () => {
  test("fails with exact candidates then accepts a selected numeric successor", async () => {
    const content = "header\nx target one\nmiddle\ny target two\nfooter";
    const { file, view } = await viewFixture(content);
    const failed = await view({
      path: "notes.txt",
      locator: "target",
      context_lines: 1,
    });
    expect(failed).toMatchObject({
      ok: false,
      errorCode: "ambiguous_text_locator",
      producedNewInformation: false,
      data: {
        path: "notes.txt",
        candidates: [
          {
            matchStartLine: 2,
            matchEndLine: 2,
            rangeTruncated: false,
            nextControls: { path: "notes.txt", start_line: 1, end_line: 3 },
          },
          {
            matchStartLine: 4,
            matchEndLine: 4,
            rangeTruncated: false,
            nextControls: { path: "notes.txt", start_line: 3, end_line: 5 },
          },
        ],
        truncation: { candidatesTruncated: false, scanTruncated: false },
      },
    });
    expect(failed.actions ?? []).toEqual([]);
    const candidates = failed.data!.candidates as LocatorCandidate[];
    expect(candidates[1]!.nextControls).not.toHaveProperty("locator");
    const successor = await view(candidates[1]!.nextControls);
    expect(successor).toMatchObject({
      ok: true,
      data: { range: { startLine: 3, endLine: 5 } },
    });
    expect(successor.output).toContain("y target two");
    expect(successor.output).not.toContain("x target one");
    expect(await readFile(file, "utf8")).toBe(content);
  });

  test("bounds candidate count without presenting it as all file matches", async () => {
    const { view } = await viewFixture(
      Array.from({ length: 30 }, (_, index) => "target " + index).join("\n"),
    );
    const failed = await view({ path: "notes.txt", locator: "target" });
    expect(failed).toMatchObject({
      ok: false,
      errorCode: "ambiguous_text_locator",
      data: {
        observedMatchCountLowerBound: 9,
        truncation: {
          candidateLimit: 8,
          candidatesTruncated: true,
          scanTruncated: false,
        },
      },
    });
    expect(failed.data!.candidates).toHaveLength(8);
  });

  test.each([
    { content: "aaa", returned: 2, observed: 2, truncated: false },
    { content: "a".repeat(10), returned: 8, observed: 9, truncated: true },
  ])(
    "counts overlapping literal matches in $content",
    async ({ content, returned, observed, truncated }) => {
      const { view } = await viewFixture(content);
      const failed = await view({ path: "notes.txt", locator: "aa" });
      expect(failed).toMatchObject({
        ok: false,
        errorCode: "ambiguous_text_locator",
        data: {
          observedMatchCountLowerBound: observed,
          truncation: {
            candidatesTruncated: truncated,
            scanTruncated: false,
          },
        },
      });
      expect(failed.actions ?? []).toEqual([]);
      const candidates = failed.data!.candidates as LocatorCandidate[];
      expect(candidates).toHaveLength(returned);
      for (const candidate of candidates) {
        expect(candidate).toEqual({
          matchStartLine: 1,
          matchEndLine: 1,
          rangeTruncated: false,
          nextControls: { path: "notes.txt", start_line: 1, end_line: 1 },
        });
      }
      const successor = await view(candidates[0]!.nextControls);
      expect(successor).toMatchObject({
        ok: true,
        data: { range: { startLine: 1, endLine: 1 } },
      });
      expect(successor.output).toContain(content);
    },
  );

  test("declares bounded scan independently from candidate truncation", async () => {
    const { view } = await viewFixture(
      "target one\ntarget two\n" +
        "x".repeat(DEV_SCAN_BYTES) +
        "\ntarget unseen",
    );
    const failed = await view({ path: "notes.txt", locator: "target" });
    expect(failed).toMatchObject({
      ok: false,
      errorCode: "ambiguous_text_locator",
      data: {
        observedMatchCountLowerBound: 2,
        truncation: {
          candidatesTruncated: false,
          scanTruncated: true,
          omittedBytes: expect.any(Number),
        },
      },
    });
    expect(failed.data!.candidates).toHaveLength(2);
    expect(
      (failed.data!.truncation as { omittedBytes: number }).omittedBytes,
    ).toBeGreaterThan(0);
  });

  test("preserves exact literal multiline matching and line coordinates", async () => {
    const { view } = await viewFixture(
      "first\r\na.b\r\nfinish\r\naxb\r\na.b\r\nfinish\r\nlast",
    );
    const failed = await view({
      path: "notes.txt",
      locator: "a.b\r\nfinish",
      context_lines: 1,
    });
    expect(failed).toMatchObject({
      ok: false,
      data: {
        candidates: [
          { matchStartLine: 2, matchEndLine: 3 },
          { matchStartLine: 5, matchEndLine: 6 },
        ],
      },
    });
  });

  test("preserves unique locator, numeric and missing-locator outcomes", async () => {
    const { view } = await viewFixture("alpha\nbeta\ngamma");
    const unique = await view({
      path: "notes.txt",
      locator: "beta",
      context_lines: 1,
    });
    const numeric = await view({
      path: "notes.txt",
      start_line: 1,
      end_line: 3,
    });
    expect(unique).toEqual(numeric);
    const missing = await view({ path: "notes.txt", locator: "absent" });
    expect(missing).toMatchObject({
      ok: true,
      data: { locatorFound: false, itemCount: 0 },
    });
  });

  test("keeps each suggested range within the existing line-window bound", async () => {
    const locator = Array.from({ length: 260 }, (_, index) =>
      String(index),
    ).join("\n");
    const { view } = await viewFixture(locator + "\ny\n" + locator);
    const failed = await view({ path: "notes.txt", locator });
    expect(failed).toMatchObject({
      ok: false,
      errorCode: "ambiguous_text_locator",
    });
    const candidates = failed.data!.candidates as LocatorCandidate[];
    expect(candidates).toHaveLength(2);
    for (const candidate of candidates) {
      expect(candidate.rangeTruncated).toBe(true);
      expect(
        candidate.nextControls.end_line - candidate.nextControls.start_line + 1,
      ).toBeLessThanOrEqual(240);
    }
  });
});
