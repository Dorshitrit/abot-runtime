import { parse } from "@babel/parser";
import { CssSyntaxError, parse as parseCss } from "postcss";
import { extname } from "node:path";

import { fail } from "../errors.js";
import type { DraftDiagnostic, DraftValidator } from "./types.js";

const SCRIPT_EXTENSIONS = new Set([
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".cjs",
]);

function validateJson(content: string): DraftDiagnostic | undefined {
  try {
    JSON.parse(content);
    return undefined;
  } catch (error: unknown) {
    const message = (
      error instanceof Error && error.message.trim()
        ? error.message.trim()
        : "JSON syntax is invalid."
    ).slice(0, 500);
    const explicit = /line\s+(\d+)\s+column\s+(\d+)/iu.exec(message);
    const offsetMatch = /position\s+(\d+)/iu.exec(message);
    const offset = offsetMatch
      ? Number.parseInt(offsetMatch[1]!, 10)
      : undefined;
    const derived =
      offset === undefined ? undefined : lineColumnAt(content, offset);
    return Object.freeze({
      code: "json_syntax_invalid",
      message,
      ...(offset === undefined ? {} : { offset }),
      ...(explicit
        ? { line: Number.parseInt(explicit[1]!, 10) }
        : derived
          ? { line: derived.line }
          : {}),
      ...(explicit
        ? { column: Number.parseInt(explicit[2]!, 10) }
        : derived
          ? { column: derived.column }
          : {}),
    });
  }
}

function lineColumnAt(content: string, offset: number): LineColumn {
  const prefix = content.slice(
    0,
    Math.min(Math.max(offset, 0), content.length),
  );
  const lines = prefix.split(/\r?\n/u);
  return Object.freeze({
    line: lines.length,
    column: (lines.at(-1)?.length ?? 0) + 1,
  });
}

type LineColumn = Readonly<{ line: number; column: number }>;

function scriptOptions(targetPath: string) {
  const extension = extname(targetPath).toLowerCase();
  const plugins: ("jsx" | "typescript")[] = [];
  if ([".js", ".jsx", ".mjs", ".cjs", ".tsx"].includes(extension)) {
    plugins.push("jsx");
  }
  if ([".ts", ".tsx"].includes(extension)) plugins.push("typescript");
  return {
    sourceType:
      extension === ".mjs"
        ? ("module" as const)
        : extension === ".cjs"
          ? ("commonjs" as const)
          : ("unambiguous" as const),
    sourceFilename: targetPath,
    plugins,
    attachComment: false,
    errorRecovery: false,
  };
}

function parseScript(
  content: string,
  targetPath: string,
): SyntaxError | undefined {
  try {
    parse(content, scriptOptions(targetPath));
    return undefined;
  } catch (error: unknown) {
    if (!(error instanceof SyntaxError)) throw error;
    return error;
  }
}

type BabelSyntaxError = SyntaxError &
  Readonly<{
    reasonCode?: string;
    pos?: number;
    loc?: Readonly<{ line?: number; column?: number }>;
  }>;

function scriptDiagnostic(error: SyntaxError): DraftDiagnostic {
  const typed = error as BabelSyntaxError;
  return Object.freeze({
    code: typed.reasonCode
      ? `script_syntax_${typed.reasonCode}`
      : "script_syntax_invalid",
    message: error.message || "JavaScript/TypeScript syntax is invalid.",
    ...(typed.pos === undefined ? {} : { offset: typed.pos }),
    ...(typed.loc?.line === undefined ? {} : { line: typed.loc.line }),
    ...(typed.loc?.column === undefined
      ? {}
      : { column: typed.loc.column + 1 }),
  });
}

function wrapperDiagnostic(
  line: string,
  lineIndex: number,
  boundary: "opening" | "closing",
  repairAttemptLimit: number,
): DraftDiagnostic {
  const lineNumber = lineIndex + 1;
  return Object.freeze({
    code: `script_source_html_${boundary}_wrapper`,
    message: `Standalone script source must not contain an HTML ${boundary} wrapper.`,
    line: lineNumber,
    column: line.search(/\S/u) + 1,
    repairScope: Object.freeze({ startLine: lineNumber, endLine: lineNumber }),
    repairAttemptLimit,
  });
}

function foreignScriptWrapper(
  content: string,
  targetPath: string,
  originalError: SyntaxError | undefined,
): DraftDiagnostic | undefined {
  const lines = content.split(/\r?\n/u);
  const first = lines.findIndex((line) => line.trim().length > 0);
  let last = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index]!.trim()) {
      last = index;
      break;
    }
  }
  if (first < 0 || last < first) return undefined;
  const opening = /^<script(?:\s[^>]*)?>$/iu.test(lines[first]!.trim());
  const closing = /^<\/script\s*>$/iu.test(lines[last]!.trim());
  const parsesWithout = (...indexes: number[]): boolean => {
    const projected = [...lines];
    for (const index of indexes) projected[index] = "";
    return parseScript(projected.join("\n"), targetPath) === undefined;
  };
  if (opening && closing && first < last && parsesWithout(first, last)) {
    const extension = extname(targetPath).toLowerCase();
    if (!originalError && [".jsx", ".tsx"].includes(extension))
      return undefined;
    return wrapperDiagnostic(lines[first]!, first, "opening", 2);
  }
  if (opening && parsesWithout(first)) {
    return wrapperDiagnostic(lines[first]!, first, "opening", 1);
  }
  if (closing && parsesWithout(last)) {
    return wrapperDiagnostic(lines[last]!, last, "closing", 1);
  }
  return undefined;
}

const validators: readonly DraftValidator[] = Object.freeze([
  Object.freeze({
    id: "json",
    label: "strict JSON",
    authoritativeStructure: true,
    matchesTarget: (targetPath: string) =>
      extname(targetPath).toLowerCase() === ".json",
    validate: (content: string) => validateJson(content),
  }),
  Object.freeze({
    id: "css",
    label: "CSS",
    authoritativeStructure: true,
    matchesTarget: (targetPath: string) =>
      extname(targetPath).toLowerCase() === ".css",
    validate(content: string, targetPath: string) {
      try {
        parseCss(content, { from: targetPath });
        return undefined;
      } catch (error: unknown) {
        if (!(error instanceof CssSyntaxError)) throw error;
        return Object.freeze({
          code: "css_syntax_invalid",
          message: error.reason || error.message,
          ...(Number.isSafeInteger(error.line) ? { line: error.line } : {}),
          ...(Number.isSafeInteger(error.column)
            ? { column: error.column }
            : {}),
        });
      }
    },
  }),
  Object.freeze({
    id: "script",
    label: "JavaScript/TypeScript",
    authoritativeStructure: true,
    matchesTarget: (targetPath: string) =>
      SCRIPT_EXTENSIONS.has(extname(targetPath).toLowerCase()),
    validate(content: string, targetPath: string) {
      const error = parseScript(content, targetPath);
      return (
        foreignScriptWrapper(content, targetPath, error) ??
        (error ? scriptDiagnostic(error) : undefined)
      );
    },
  }),
]);

export function resolveDraftValidator(
  targetPath: string,
): DraftValidator | undefined {
  const matches = validators.filter((validator) =>
    validator.matchesTarget(targetPath),
  );
  if (matches.length > 1) {
    fail(
      "file_draft_validator_ambiguous",
      `Multiple draft validators matched ${targetPath}.`,
    );
  }
  return matches[0];
}
