import {
  failureResult,
  successResult,
  type ResolvedRuntimeToolPath,
  type ToolImplementationOutput,
} from "../../../src/plugin-sdk/index.js";
import type { ProjectManifestSummary } from "./manifest-summary.js";
import {
  bindProjectPageCursor,
  encodeProjectPageCursor,
  resolveProjectPageOffset,
  type ProjectPageCursorBinding,
} from "./page-cursor.js";
import type { ProjectTreeEntry, ProjectTreeListing } from "./tree.js";

export const PROJECT_PAGE_ENTRY_LIMIT = 40;
export const PROJECT_RESULT_MAX_CHARS = 4_000;

type ProjectInspectionPageInput = Readonly<{
  target: ResolvedRuntimeToolPath;
  depth: number;
  maxEntries: number;
  cursor?: string;
  listing: ProjectTreeListing;
  manifests: readonly ProjectManifestSummary[];
}>;
type PageContext = Readonly<{
  input: ProjectInspectionPageInput;
  binding: ProjectPageCursorBinding;
  offset: number;
}>;

function fitsResultBudget(result: ToolImplementationOutput): boolean {
  return JSON.stringify(result).length <= PROJECT_RESULT_MAX_CHARS;
}

function hasManifestOmissions(
  source: readonly ProjectManifestSummary[],
  projected: readonly ProjectManifestSummary[],
): boolean {
  return source.some((manifest) => manifest.scriptsTruncated === true || manifest.identityTruncated === true)
    || JSON.stringify(source) !== JSON.stringify(projected);
}

function pageCandidate(
  context: PageContext,
  entries: readonly ProjectTreeEntry[],
  manifests: readonly ProjectManifestSummary[],
): ToolImplementationOutput {
  const { input, binding, offset } = context;
  const directories = entries.filter((entry) => entry.kind === "directory").map((entry) => entry.path);
  const files = entries.filter((entry) => entry.kind === "file").map((entry) => entry.path);
  const nextOffset = offset + entries.length;
  const hasMore = nextOffset < input.listing.entries.length;
  const treeTruncated = offset > 0 || hasMore;
  const output = `Project overview: ${directories.length} directories and ${files.length} files in this page. ${hasMore ? "More entries are available using the continuation cursor." : "No further entries in this listing."}`;
  return {
    ok: true,
    output,
    producedNewInformation: true,
    data: {
      location: input.target.location,
      target: input.target.logicalPath,
      depth: input.depth,
      maxEntries: input.maxEntries,
      tree: {
        directories,
        files,
        entries: entries.length,
        truncated: treeTruncated,
        truncatedPathCount: 0,
        sampling: "complete_bounded_directory_scan",
      },
      manifests,
      pagination: {
        hasMore,
        nextCursor: hasMore ? encodeProjectPageCursor(binding, nextOffset) : null,
      },
      truncation: {
        output: { truncated: false, originalChars: output.length, returnedChars: output.length, omittedChars: 0 },
        tree: treeTruncated,
        pathCount: 0,
        manifests: hasManifestOmissions(input.manifests, manifests),
      },
      observationMeta: { kind: "volatile_external", carryPolicy: "never" },
    },
  };
}

function replaceManifest(
  manifests: readonly ProjectManifestSummary[],
  index: number,
  replacement: ProjectManifestSummary,
): ProjectManifestSummary[] {
  return manifests.map((manifest, position) => position === index ? replacement : manifest);
}

function fitManifestDetails(
  context: PageContext,
  entries: readonly ProjectTreeEntry[],
  manifests: ProjectManifestSummary[],
  index: number,
): ProjectManifestSummary[] {
  const source = context.input.manifests[index]!;
  let projected = manifests;
  for (const field of ["name", "version", "private"] as const) {
    if (source[field] === undefined) continue;
    const candidate = replaceManifest(projected, index, { ...projected[index]!, [field]: source[field] });
    if (fitsResultBudget(pageCandidate(context, entries, candidate))) projected = candidate;
  }
  if (!source.scripts) return projected;
  const scripts: string[] = [];
  for (const script of source.scripts) {
    const next = [...scripts, script];
    const candidate = replaceManifest(projected, index, {
      ...projected[index]!,
      scripts: next,
      scriptsTruncated: source.scriptsTruncated === true || next.length < source.scripts.length,
    });
    if (!fitsResultBudget(pageCandidate(context, entries, candidate))) break;
    scripts.push(script);
    projected = candidate;
  }
  return projected;
}

function fitManifests(
  context: PageContext,
  entries: readonly ProjectTreeEntry[],
): readonly ProjectManifestSummary[] {
  let projected: ProjectManifestSummary[] = [];
  for (const source of context.input.manifests) {
    const hasOmittedScripts = source.scriptsTruncated === true || (source.scripts?.length ?? 0) > 0;
    const binding: ProjectManifestSummary = {
      file: source.file,
      ...(source.status ? { status: source.status } : {}),
      ...(source.identityTruncated ? { identityTruncated: true } : {}),
      ...(hasOmittedScripts ? { scriptsTruncated: true } : {}),
    };
    const candidate = [...projected, binding];
    if (!fitsResultBudget(pageCandidate(context, entries, candidate))) break;
    projected = candidate;
  }
  for (let index = 0; index < projected.length; index += 1) {
    const source = context.input.manifests[index]!;
    const complete = replaceManifest(projected, index, source);
    if (fitsResultBudget(pageCandidate(context, entries, complete))) {
      projected = complete;
      continue;
    }
    projected = fitManifestDetails(context, entries, projected, index);
  }
  return projected;
}

function unrepresentableEntry(): ToolImplementationOutput {
  return failureResult({
    errorCode: "project_entry_exceeds_budget",
    message: "A complete project path cannot fit within the 4000-character result limit. Inspect a nearer parent with depth 0 or a narrower target; no abbreviated path or continuation was returned.",
  });
}

export function buildProjectInspectionPage(
  input: ProjectInspectionPageInput,
): ToolImplementationOutput {
  const binding = bindProjectPageCursor(input.target, input.depth, input.listing);
  const offset = resolveProjectPageOffset(input.cursor, binding);
  const context: PageContext = { input, binding, offset };
  const pageLimit = Math.min(input.maxEntries, PROJECT_PAGE_ENTRY_LIMIT);
  const entries = input.listing.entries.slice(offset, offset + pageLimit);
  // The last page has no cursor, so it can fit where a shorter prefix cannot.
  while (entries.length > 0 && !fitsResultBudget(pageCandidate(context, entries, []))) {
    entries.pop();
  }
  if (entries.length === 0 && offset < input.listing.entries.length) return unrepresentableEntry();
  if (!fitsResultBudget(pageCandidate(context, entries, []))) return unrepresentableEntry();
  const manifests = fitManifests(context, entries);
  const result = pageCandidate(context, entries, manifests);
  return successResult({ output: result.output, producedNewInformation: true, data: result.data });
}

export function boundProjectInspectionFailure(
  result: ToolImplementationOutput,
): ToolImplementationOutput {
  if (fitsResultBudget(result)) return result;
  const bounded = failureResult({
    errorCode: result.errorCode ?? "project_orientation_failed",
    message: "Project inspection failed. Error details exceeded the bounded result limit.",
    ...(result.interruption ? { interruption: result.interruption } : {}),
  });
  if (fitsResultBudget(bounded)) return bounded;
  return failureResult({
    errorCode: "project_orientation_failed",
    message: "Project inspection failed. Error metadata exceeded the bounded result limit.",
    ...(result.interruption ? { interruption: result.interruption } : {}),
  });
}
