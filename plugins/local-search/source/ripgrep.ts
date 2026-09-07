import { TextDecoder } from "node:util";

import { LocalSearchError } from "./errors.js";
import {
  spawnRipgrepProcess,
  type SearchDirectoryAuthority,
} from "./ripgrep-process.js";

const SEARCH_TIMEOUT_MS = 10_000;
const MAX_PATH_RECORD_BYTES = 64 * 1024;
const MAX_JSON_RECORD_BYTES = 512 * 1024;
const IGNORED_GLOBS = Object.freeze([
  "!.git/**",
  "!node_modules/**",
  "!dist/**",
  "!coverage/**",
  "!.runtime/**",
]);

export type ContentMatch = Readonly<{
  path: string;
  lineNumber: number;
  text: string;
}>;

export type BoundedRipgrepResult<T> = Readonly<{
  items: readonly T[];
  truncated: boolean;
}>;

type RipgrepStreamParser<T> = Readonly<{
  push(chunk: Buffer, accept: (value: T) => boolean): void;
  finish(accept: (value: T) => boolean): void;
}>;

export function rgGlobArgs(): readonly string[] {
  return Object.freeze(IGNORED_GLOBS.flatMap((glob) => ["--glob", glob]));
}

export function escapeRgGlobLiteral(value: string): string {
  return [...value]
    .map((character) =>
      "\\*?[]{}!".includes(character) ? `\\${character}` : character,
    )
    .join("");
}

function decodeUtf8Record(bytes: Buffer, kind: "path" | "result"): string {
  let value: string;
  try {
    value = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new LocalSearchError(
      "local_search_result_encoding_unsupported",
      `Local search found ${kind === "path" ? "a path" : "text"} with unsupported encoding.`,
    );
  }
  return value;
}

function createDelimitedParser<T>(params: {
  delimiter: number;
  maxRecordBytes: number;
  parse(record: Buffer): T | undefined;
}): RipgrepStreamParser<T> {
  let pending = Buffer.alloc(0);

  const parseAvailable = (
    chunk: Buffer,
    includeTrailing: boolean,
    accept: (value: T) => boolean,
  ): void => {
    const combined =
      pending.length > 0 ? Buffer.concat([pending, chunk]) : chunk;
    let start = 0;
    for (;;) {
      const end = combined.indexOf(params.delimiter, start);
      if (end < 0) break;
      if (end - start > params.maxRecordBytes) {
        throw new LocalSearchError(
          "local_search_result_invalid",
          "Local search returned an oversized result record.",
        );
      }
      const parsed = params.parse(combined.subarray(start, end));
      if (parsed !== undefined && !accept(parsed)) {
        pending = Buffer.alloc(0);
        return;
      }
      start = end + 1;
    }
    const trailing = combined.subarray(start);
    if (trailing.length > params.maxRecordBytes) {
      throw new LocalSearchError(
        "local_search_result_invalid",
        "Local search returned an oversized result record.",
      );
    }
    pending = Buffer.from(trailing);
    if (includeTrailing && pending.length > 0) {
      const parsed = params.parse(pending);
      pending = Buffer.alloc(0);
      if (parsed !== undefined) accept(parsed);
    }
  };

  return Object.freeze({
    push: (chunk: Buffer, accept: (value: T) => boolean) =>
      parseAvailable(chunk, false, accept),
    finish: (accept: (value: T) => boolean) =>
      parseAvailable(Buffer.alloc(0), true, accept),
  });
}

async function runRipgrepBounded<T>(
  args: readonly string[],
  cwd: string,
  maxResults: number,
  parser: RipgrepStreamParser<T>,
  signal?: AbortSignal,
  stdinFd?: number,
  directoryAuthority?: SearchDirectoryAuthority,
): Promise<BoundedRipgrepResult<T>> {
  if (signal?.aborted) {
    throw new LocalSearchError(
      "local_search_failed",
      "Local search could not complete under the selected logical root.",
    );
  }
  return new Promise<BoundedRipgrepResult<T>>((resolve, reject) => {
    const items: T[] = [];
    let completed = false;
    let stoppedAfterExtraResult = false;
    let timedOut = false;
    let aborted = false;
    let parserError: unknown;
    const { child, terminate } = spawnRipgrepProcess(
      args,
      cwd,
      stdinFd,
      directoryAuthority,
    );

    const cleanup = (): void => {
      clearTimeout(timeout);
      if (signal && abortListener) {
        signal.removeEventListener("abort", abortListener);
      }
    };
    const settleFailure = (error?: unknown): void => {
      if (completed) return;
      completed = true;
      cleanup();
      reject(
        error instanceof LocalSearchError
          ? error
          : new LocalSearchError(
              "local_search_failed",
              "Local search could not complete under the selected logical root.",
            ),
      );
    };
    const accept = (value: T, mayStopProcess: boolean): boolean => {
      if (items.length < maxResults) {
        items.push(value);
        return true;
      }
      stoppedAfterExtraResult = true;
      if (mayStopProcess) {
        child.stdout.pause();
        terminate();
      }
      return false;
    };
    const abortListener = (): void => {
      aborted = true;
      terminate();
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      terminate();
    }, SEARCH_TIMEOUT_MS);
    timeout.unref?.();

    child.stdout.on("data", (chunk: Buffer) => {
      if (completed || stoppedAfterExtraResult || parserError) return;
      try {
        parser.push(chunk, (value) => accept(value, true));
      } catch (error) {
        parserError = error;
        child.stdout.pause();
        terminate();
      }
    });
    // Always drain stderr so the child cannot block on its diagnostic pipe.
    child.stderr.on("data", () => undefined);
    child.on("error", (error) => settleFailure(error));
    child.on("close", (code) => {
      if (completed) return;
      if (parserError) {
        settleFailure(parserError);
        return;
      }
      if (timedOut || aborted) {
        settleFailure();
        return;
      }
      if (!stoppedAfterExtraResult) {
        try {
          parser.finish((value) => accept(value, false));
        } catch (error) {
          settleFailure(error);
          return;
        }
      }
      if (!stoppedAfterExtraResult && code !== 0 && code !== 1) {
        settleFailure();
        return;
      }
      completed = true;
      cleanup();
      resolve(
        Object.freeze({
          items: Object.freeze(items),
          truncated: stoppedAfterExtraResult,
        }),
      );
    });
    if (signal) {
      if (signal.aborted) abortListener();
      else signal.addEventListener("abort", abortListener, { once: true });
    }
  });
}

function requiredJsonText(value: unknown): string {
  if (!value || typeof value !== "object") {
    throw new LocalSearchError(
      "local_search_result_invalid",
      "Local search returned invalid data.",
    );
  }
  const record = value as Readonly<Record<string, unknown>>;
  if (typeof record.text !== "string") {
    if ("bytes" in record) {
      throw new LocalSearchError(
        "local_search_result_encoding_unsupported",
        "Local search found text with unsupported encoding.",
      );
    }
    throw new LocalSearchError(
      "local_search_result_invalid",
      "Local search returned invalid data.",
    );
  }
  return record.text;
}

function parseJsonContentEvent(line: string): ContentMatch | undefined {
  if (!line) return undefined;
  let event: unknown;
  try {
    event = JSON.parse(line) as unknown;
  } catch {
    throw new LocalSearchError(
      "local_search_result_invalid",
      "Local search returned invalid data.",
    );
  }
  if (!event || typeof event !== "object") return undefined;
  const eventRecord = event as Readonly<Record<string, unknown>>;
  if (eventRecord.type !== "match") return undefined;
  const data = eventRecord.data;
  if (!data || typeof data !== "object") {
    throw new LocalSearchError(
      "local_search_result_invalid",
      "Local search returned invalid data.",
    );
  }
  const dataRecord = data as Readonly<Record<string, unknown>>;
  if (
    !Number.isSafeInteger(dataRecord.line_number) ||
    Number(dataRecord.line_number) < 1
  ) {
    throw new LocalSearchError(
      "local_search_result_invalid",
      "Local search returned invalid data.",
    );
  }
  const text = requiredJsonText(dataRecord.lines);
  return Object.freeze({
    path: requiredJsonText(dataRecord.path),
    lineNumber: Number(dataRecord.line_number),
    text: text.endsWith("\r\n")
      ? text.slice(0, -2)
      : text.endsWith("\n")
        ? text.slice(0, -1)
        : text,
  });
}

export function runRipgrepPathSearch(
  args: readonly string[],
  cwd: string,
  maxResults: number,
  signal?: AbortSignal,
  directoryAuthority?: SearchDirectoryAuthority,
): Promise<BoundedRipgrepResult<string>> {
  return runRipgrepBounded(
    args,
    cwd,
    maxResults,
    createDelimitedParser({
      delimiter: 0,
      maxRecordBytes: MAX_PATH_RECORD_BYTES,
      parse: (record) => decodeUtf8Record(record, "path"),
    }),
    signal,
    undefined,
    directoryAuthority,
  );
}

export function runRipgrepContentSearch(
  args: readonly string[],
  cwd: string,
  maxResults: number,
  signal?: AbortSignal,
  stdinFd?: number,
  directoryAuthority?: SearchDirectoryAuthority,
): Promise<BoundedRipgrepResult<ContentMatch>> {
  return runRipgrepBounded(
    args,
    cwd,
    maxResults,
    createDelimitedParser({
      delimiter: 0x0a,
      maxRecordBytes: MAX_JSON_RECORD_BYTES,
      parse: (record) => {
        const normalized =
          record.at(-1) === 0x0d ? record.subarray(0, -1) : record;
        return parseJsonContentEvent(decodeUtf8Record(normalized, "result"));
      },
    }),
    signal,
    stdinFd,
    directoryAuthority,
  );
}
