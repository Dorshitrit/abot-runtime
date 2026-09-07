import { join } from "node:path";

import {
  defineRuntimePlugin,
  failureFromError,
  failureResult,
  readBoundedInteger,
  readRequiredString,
  successResult,
  type ToolImplementationOutput,
} from "../../../src/plugin-sdk/index.js";

import { renderEntries } from "./format.js";
import { searchMemory } from "./search.js";
import { MemoryStore } from "./store.js";
import { isMemoryStoreError } from "./types.js";

const MAX_MEMORY_CONTENT_LENGTH = 2_000;
const SEARCH_RESULT_LIMIT = 10;
const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 100;

function memoryFailure(
  error: unknown,
  operation: string,
): ToolImplementationOutput {
  if (isMemoryStoreError(error)) {
    return failureResult({ errorCode: error.code, message: error.message });
  }
  return failureFromError(error, {
    fallbackCode: "memory_operation_failed",
    fallbackMessage: "Memory operation failed.",
    operation,
  });
}

export default defineRuntimePlugin((context) => {
  const store = new MemoryStore({
    filePath: join(context.stateDir, "memory.json"),
    legacyFilePaths: [
      join(context.runtimePaths.runtimeDir, "memory", "memory.json"),
      join(context.runtimePaths.rootDir, "memory", "memory.json"),
    ],
  });

  return {
    handlers: {
      async memory_get(params) {
        try {
          const offset = readBoundedInteger(params.offset, {
            defaultValue: 0,
            minimum: 0,
            maximum: 1_000_000,
            name: "offset",
          });
          const limit = readBoundedInteger(params.limit, {
            defaultValue: DEFAULT_PAGE_LIMIT,
            minimum: 1,
            maximum: MAX_PAGE_LIMIT,
            name: "limit",
          });
          const state = await store.read();
          const page = state.entries.slice(offset, offset + limit);
          const rendered = renderEntries(page, {
            heading: `Memory entries: ${state.entries.length} (offset ${offset})`,
            totalEntries: Math.max(state.entries.length - offset, 0),
          });
          const nextOffset =
            offset + rendered.returnedEntries < state.entries.length
              ? offset + rendered.returnedEntries
              : undefined;
          return successResult({
            output: rendered.output,
            progress: rendered.returnedEntries > 0,
            producedNewInformation: rendered.returnedEntries > 0,
            data: {
              hasData: rendered.returnedEntries > 0,
              itemCount: state.entries.length,
              returnedItemCount: rendered.returnedEntries,
              offset,
              limit,
              ...(nextOffset !== undefined ? { nextOffset } : {}),
              truncated: rendered.truncated,
              outputMaxChars: rendered.outputMaxChars,
              ...(rendered.returnedEntries > 0
                ? {
                    observationMeta: {
                      kind: "stable_fact" as const,
                      carryPolicy: "always" as const,
                    },
                  }
                : {}),
            },
          });
        } catch (error) {
          return memoryFailure(error, "memory_get");
        }
      },

      async memory_search(params) {
        try {
          const query = readRequiredString(params.query, {
            name: "query",
            maxLength: 4_096,
          });
          const state = await store.read();
          const result = searchMemory(
            state.entries,
            query,
            SEARCH_RESULT_LIMIT,
          );
          const rendered = renderEntries(result.matches, {
            heading: `Search query: ${query}\nMemory matches: ${result.totalMatches}`,
            totalEntries: result.totalMatches,
          });
          return successResult({
            output: rendered.output,
            progress: rendered.returnedEntries > 0,
            producedNewInformation: rendered.returnedEntries > 0,
            data: {
              hasData: rendered.returnedEntries > 0,
              itemCount: result.totalMatches,
              memoryItemCount: result.totalMatches,
              returnedItemCount: rendered.returnedEntries,
              satisfiedStoredStateLookup: result.totalMatches > 0,
              truncated: rendered.truncated,
              outputMaxChars: rendered.outputMaxChars,
              ...(rendered.returnedEntries > 0
                ? {
                    observationMeta: {
                      kind: "stable_fact" as const,
                      carryPolicy: "always" as const,
                    },
                  }
                : {}),
            },
          });
        } catch (error) {
          return memoryFailure(error, "memory_search");
        }
      },

      async memory_add(params) {
        try {
          const content = readRequiredString(params.content, {
            name: "content",
            maxLength: MAX_MEMORY_CONTENT_LENGTH,
          });
          const entry = await store.add(content);
          return successResult({
            output: [
              "Memory add: success",
              `id: ${entry.id}`,
              `content: ${entry.content}`,
            ].join("\n"),
            progress: true,
            producedNewInformation: true,
            actions: [{ type: "memory_add", target: entry.id }],
            data: { mutationEvidence: true, id: entry.id },
          });
        } catch (error) {
          return memoryFailure(error, "memory_add");
        }
      },

      async memory_delete(params) {
        try {
          const id = readRequiredString(params.id, {
            name: "id",
            maxLength: 128,
          });
          const deletedCount = await store.delete(id);
          const hasDeletedMemoryEntries = deletedCount > 0;
          return successResult({
            output: [
              `Memory delete: ${hasDeletedMemoryEntries ? "success" : "no_match"}`,
              `id: ${id}`,
              `deleted: ${deletedCount}`,
              ...(hasDeletedMemoryEntries
                ? []
                : [
                    "No memory entry matched that ID. Retrieve memory before retrying.",
                  ]),
            ].join("\n"),
            progress: hasDeletedMemoryEntries,
            producedNewInformation: hasDeletedMemoryEntries,
            data: {
              ...(hasDeletedMemoryEntries ? { mutationEvidence: true } : {}),
              deletedCount,
            },
            ...(hasDeletedMemoryEntries
              ? {
                  actions: [{ type: "memory_delete", target: id }],
                }
              : {}),
          });
        } catch (error) {
          return memoryFailure(error, "memory_delete");
        }
      },
    },
  };
});
