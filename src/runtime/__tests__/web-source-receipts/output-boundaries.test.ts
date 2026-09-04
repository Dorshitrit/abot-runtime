import { describe, expect, test } from "vitest";

import {
  boundSourceOutput,
  projectSourceReceipts,
} from "../../../../plugins/web/source/source-output-receipts.js";
import { renderSearchSource } from "../../../../plugins/web/source/search-source-presentation.js";
import { hit, page } from "./receipt-fixture.js";

describe("source receipt boundaries", () => {
  test("requires the complete URL field before declaring a reference", () => {
    const block = renderSearchSource(hit());
    expect(
      projectSourceReceipts(
        [block.occurrence],
        block.occurrence.referenceEnd - 1,
      )[0]?.presentation,
    ).toBe("omitted");
    expect(
      projectSourceReceipts(
        [block.occurrence],
        block.occurrence.referenceEnd,
      )[0]?.presentation,
    ).toBe("reference");
  });

  test.each(["😀 continued", "\ncontinued", "\u2028continued", '"continued'])(
    "requires a complete encoded evidence character (%j)",
    (snippet) => {
      const block = renderSearchSource(hit(0, { snippet }));
      const boundary = block.occurrence.snippet!.firstCharacterEnd;
      expect(
        projectSourceReceipts([block.occurrence], boundary - 1)[0]
          ?.presentation,
      ).toBe("reference");
      expect(
        projectSourceReceipts([block.occurrence], boundary)[0],
      ).toMatchObject({ presentation: "snippet", contentTruncated: true });
    },
  );

  test("distinguishes a complete snippet from an omitted content block", () => {
    const source = hit();
    const block = renderSearchSource(source, { hit: source, page: page() });
    const receipt = projectSourceReceipts(
      [block.occurrence],
      block.occurrence.snippet!.end,
    )[0];
    expect(receipt).toMatchObject({
      retrieval: "retrieved",
      presentation: "snippet",
      contentTruncated: false,
    });
  });

  test("counts the actual byte prefix and never counts a truncation marker as evidence", () => {
    const block = renderSearchSource(hit(0, { snippet: "😀".repeat(100) }));
    const maxBytes = Buffer.byteLength(
      block.text.slice(0, block.occurrence.snippet!.firstCharacterEnd - 1),
      "utf8",
    );
    const bounded = boundSourceOutput(block.text, { maxBytes, marker: "" });
    expect(
      projectSourceReceipts([block.occurrence], bounded.visibleChars)[0]
        ?.presentation,
    ).toBe("reference");
    expect(Buffer.byteLength(bounded.output, "utf8")).toBeLessThanOrEqual(
      maxBytes,
    );
    const allMarker = boundSourceOutput(block.text, {
      maxChars: 10,
      maxBytes: 10,
      marker: "[truncated]",
    });
    expect(
      projectSourceReceipts([block.occurrence], allMarker.visibleChars)[0]
        ?.presentation,
    ).toBe("omitted");
  });

  test("bounds titles and source count without truncating URLs", () => {
    const blocks = Array.from({ length: 30 }, (_, index) =>
      renderSearchSource(
        hit(index, {
          title: "x".repeat(255) + "😀",
          url: `https://source.example/${index}`,
        }),
      ),
    );
    const sources = projectSourceReceipts(
      blocks.map(({ occurrence }) => occurrence),
      Number.MAX_SAFE_INTEGER,
    );
    expect(sources).toHaveLength(25);
    expect(sources.every(({ title }) => title.length <= 256)).toBe(true);
    expect(sources.every(({ title }) => !/[\ud800-\udfff]/u.test(title))).toBe(
      true,
    );
    const oversized = renderSearchSource(
      hit(0, { url: `https://source.example/${"x".repeat(4096)}` }),
    );
    expect(
      projectSourceReceipts([oversized.occurrence], Number.MAX_SAFE_INTEGER),
    ).toEqual([]);
  });
});
