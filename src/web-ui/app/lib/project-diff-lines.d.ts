export type ProjectDiffLine = {
  kind: "meta" | "hunk" | "added" | "deleted" | "context";
  oldLine: number | null; newLine: number | null; text: string;
};
export declare function projectDiffLines(patch: string | null): ProjectDiffLine[];
