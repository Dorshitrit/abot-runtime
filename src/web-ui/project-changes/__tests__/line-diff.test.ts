import { describe, expect, it } from "vitest";
import { compareProjectText } from "../line-diff.js";
describe("bounded project line diff", () => {
  it("preserves CRLF and terminal-newline differences", () => {
    expect(compareProjectText("a.txt", "line\r\n", "line\n", "100644", "100644")).toMatchObject({ status: "text", additions: 1, deletions: 1, patch: expect.stringContaining("-line\r\n+line\n") });
    expect(compareProjectText("a.txt", "line\n", "line", "100644", "100644")).toMatchObject({ status: "text", additions: 1, deletions: 1, patch: expect.stringContaining("+line\n\\ No newline at end of file\n") });
  });
  it("represents empty additions/deletions and keeps separated hunks accurate", () => {
    expect(compareProjectText("a.txt", "", "", null, "100644")).toMatchObject({ status: "text", additions: 0, deletions: 0, patch: expect.stringContaining("new file mode 100644") });
    expect(compareProjectText("a.txt", "old\n", "", "100644", null)).toMatchObject({ status: "text", additions: 0, deletions: 1, patch: expect.stringContaining("@@ -1,1 +0,0 @@") });
    const before = Array.from({ length: 30 }, (_, index) => `${index}\n`).join("");
    const after = before.replace("2\n", "two\n").replace("26\n", "twenty-six\n");
    const result = compareProjectText("a.txt", before, after, "100644", "100644");
    expect(result).toMatchObject({ status: "text", additions: 2, deletions: 2 });
    if (result.status === "text") expect(result.patch.match(/^@@/gmu)).toHaveLength(2);
  });
  it("returns an explicit bounded result rather than running quadratic work", () => {
    expect(compareProjectText("a", "x\n".repeat(1100), "y\n".repeat(1100), "100644", "100644")).toEqual({ status: "too_large" });
    expect(compareProjectText("a", "", "\n".repeat(20001), null, "100644")).toEqual({ status: "too_large" });
  });
});
