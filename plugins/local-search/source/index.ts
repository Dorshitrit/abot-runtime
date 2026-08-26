import { posix } from "node:path";

import {
  defineRuntimePlugin,
  failureFromError,
  failureResult,
  readBoolean,
  readBoundedInteger,
  readOptionalString,
  readRequiredString,
  successResult,
} from "../../../src/plugin-sdk/index.js";

import { isLocalSearchError } from "./errors.js";
import {
  budgetSearchOutput,
  type BudgetedSearchOutput,
  type SearchEntry,
} from "./output.js";
import {
  qualifyMatchPath,
  resolveSearchRoot,
  type SearchRoot,
} from "./paths.js";
import {
  escapeRgGlobLiteral,
  rgGlobArgs,
  runRipgrepContentSearch,
  runRipgrepPathSearch,
} from "./ripgrep.js";

const DEFAULT_MAX_RESULTS = 40;
const MAX_RESULTS = 200;

function fileNameMatches(
  logicalPath: string,
  query: string,
  caseSensitive: boolean,
): boolean {
  const filename = posix.basename(logicalPath);
  return caseSensitive
    ? filename.includes(query)
    : filename.toLowerCase().includes(query.toLowerCase());
}

export default defineRuntimePlugin((context) => ({
  handlers: {
    async local_search(params, executionContext) {
      let root: SearchRoot | undefined;
      try {
        const query = readRequiredString(params.query, {
          name: "query",
          maxLength: 1_024,
        });
        const rawMode = readOptionalString(params.mode) ?? "both";
        if (
          !(["names", "content", "both"] as const).includes(rawMode as never)
        ) {
          return failureResult({
            errorCode: "plugin_parameter_invalid",
            message: "mode must be names, content, or both.",
          });
        }
        const mode = rawMode as "names" | "content" | "both";
        const caseSensitive = readBoolean(params.case_sensitive, {
          defaultValue: false,
        });
        const maxResults = readBoundedInteger(params.max_results, {
          defaultValue: DEFAULT_MAX_RESULTS,
          minimum: 1,
          maximum: MAX_RESULTS,
          name: "max_results",
        });
        root = await resolveSearchRoot(context, params.path);
        const candidates: SearchEntry[] = [];
        let sourceTruncated = false;
        if (mode === "names" || mode === "both") {
          const names = root.isFile
            ? Object.freeze({
                items: Object.freeze(
                  fileNameMatches(root.target.logicalPath, query, caseSensitive)
                    ? [posix.basename(root.target.logicalPath)]
                    : [],
                ),
                truncated: false,
              })
            : await runRipgrepPathSearch(
                [
                  "--files",
                  "--null",
                  "--hidden",
                  ...rgGlobArgs(),
                  caseSensitive ? "--glob" : "--iglob",
                  `*${escapeRgGlobLiteral(query)}*`,
                  "--",
                  root.commandTarget,
                ],
                root.commandDirectory,
                maxResults,
                executionContext?.abortSignal,
              );
          sourceTruncated ||= names.truncated;
          for (const rawPath of names.items) {
            candidates.push({
              kind: "name",
              value: qualifyMatchPath(context, root, rawPath),
            });
          }
        }
        if ((mode === "content" || mode === "both") && !sourceTruncated) {
          const remaining = maxResults - candidates.length;
          const content = await runRipgrepContentSearch(
            [
              "--json",
              "--with-filename",
              "--fixed-strings",
              "--line-number",
              "--no-heading",
              "--color",
              "never",
              "--max-columns",
              "2048",
              "--max-columns-preview",
              "--hidden",
              ...(caseSensitive ? [] : ["--ignore-case"]),
              ...rgGlobArgs(),
              "--",
              query,
              root.commandTarget,
            ],
            root.commandDirectory,
            remaining,
            executionContext?.abortSignal,
            root.stdinFd,
          );
          sourceTruncated ||= content.truncated;
          for (const match of content.items) {
            candidates.push({
              kind: "content",
              value: {
                ...match,
                path: qualifyMatchPath(context, root, match.path),
              },
            });
          }
        }
        const buildResult = (bounded: BudgetedSearchOutput) =>
          successResult({
            output: bounded.output,
            producedNewInformation: true,
            actions: [
              {
                type: "inspect_target",
                target: root!.target.logicalPath,
                details: "local_search",
              },
            ],
            data: {
              hasData: bounded.entries.length > 0,
              itemCount: bounded.entries.length,
              mode,
              logicalRoot: root!.target.logicalPath,
              truncation: bounded.metadata,
              observationMeta: {
                kind: "volatile_external",
                carryPolicy: "never",
              },
            },
          });
        const bounded = budgetSearchOutput(
          query,
          mode,
          candidates,
          sourceTruncated,
          (candidate) => buildResult(candidate).ok === true,
        );
        return buildResult(bounded);
      } catch (error) {
        if (isLocalSearchError(error)) {
          return failureResult({
            errorCode: error.code,
            message: error.message,
          });
        }
        return failureFromError(error, {
          fallbackCode: "local_search_failed",
          fallbackMessage: "Local search failed.",
          operation: "local_search",
        });
      } finally {
        await root?.close().catch(() => undefined);
      }
    },
  },
}));
