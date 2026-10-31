import { describe, expect, it } from "vitest";
import { indexMatchesFile, type ProjectIndexEntry } from "../metadata.js";
import type { ProjectFileState } from "../file-state.js";

const identity = ["100", "1000000123", "1", "2", "4", "0"];
const entry: ProjectIndexEntry = { oid: "a".repeat(40), mode: "100644", conflict: false, identity };
const state: ProjectFileState = { version: "fixture", kind: "file", size: 4, identity };

describe("Git index stat freshness", () => {
  it("trusts matching stat only when the file mtime is strictly older than the index", () => {
    expect(indexMatchesFile(entry, state, 1000000124n)).toBe(true);
    expect(indexMatchesFile(entry, state, 1000000123n)).toBe(false);
    expect(indexMatchesFile(entry, state, 1000000122n)).toBe(false);
    expect(indexMatchesFile(entry, state, null)).toBe(false);
  });

  it("rejects missing, conflicted and mismatched identity independently of freshness", () => {
    expect(indexMatchesFile(undefined, state, 2000000000n)).toBe(false);
    expect(indexMatchesFile({ ...entry, conflict: true }, state, 2000000000n)).toBe(false);
    expect(indexMatchesFile(entry, { version: "missing", kind: "missing", size: 0 }, 2000000000n)).toBe(false);
    expect(indexMatchesFile(entry, { ...state, identity: [...identity.slice(0, 4), "5", "0"] }, 2000000000n)).toBe(false);
  });
});
