// GENERATED FILE - DO NOT EDIT.
// Source: plugins/document-reader/source/index.ts
// Run "npm run build:plugins" after editing plugin source.
"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// plugins/document-reader/source/index.ts
var index_exports = {};
__export(index_exports, {
  default: () => index_default
});
module.exports = __toCommonJS(index_exports);

// src/plugin-sdk/bounds.ts
function boundText(value, options) {
  if (!Number.isSafeInteger(options.maxChars) || options.maxChars < 0) {
    throw new RangeError("maxChars must be a non-negative safe integer");
  }
  const marker = options.marker ?? "\n[truncated]";
  const truncated = value.length > options.maxChars;
  const boundedMarker = marker.slice(0, options.maxChars);
  const sourceChars = truncated ? Math.max(options.maxChars - boundedMarker.length, 0) : value.length;
  const text = truncated ? value.slice(0, sourceChars) + boundedMarker : value;
  return Object.freeze({
    text,
    metadata: Object.freeze({
      truncated,
      originalChars: value.length,
      returnedChars: text.length,
      omittedChars: Math.max(value.length - sourceChars, 0)
    })
  });
}
function sanitizeJsonText(value) {
  return [...value].map((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    const preservedWhitespace = codePoint === 9 || codePoint === 10 || codePoint === 13;
    const unsafeControl = codePoint < 32 && !preservedWhitespace || codePoint >= 127 && codePoint <= 159;
    const unpairedSurrogate = codePoint >= 55296 && codePoint <= 57343;
    return unsafeControl || unpairedSurrogate ? "�" : character;
  }).join("");
}

// src/plugin-sdk/files.ts
var import_node_fs = require("node:fs");
var import_promises = require("node:fs/promises");
var import_node_path = require("node:path");
function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const error = new Error("The file read was cancelled.");
  error.name = "AbortError";
  throw error;
}
async function readExact(handle, buffer, signal) {
  let offset = 0;
  while (offset < buffer.length) {
    throwIfAborted(signal);
    const result = await handle.read(
      buffer,
      offset,
      buffer.length - offset,
      offset
    );
    if (result.bytesRead === 0) return false;
    offset += result.bytesRead;
  }
  return true;
}
async function readBoundedRegularFile(absolutePath, options) {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0) {
    throw new RangeError("maxBytes must be a non-negative safe integer");
  }
  throwIfAborted(options.signal);
  if (typeof import_node_fs.constants.O_NOFOLLOW !== "number") {
    return Object.freeze({ ok: false, reason: "safe_open_unsupported" });
  }
  let handle;
  try {
    handle = await (0, import_promises.open)(
      absolutePath,
      import_node_fs.constants.O_RDONLY | import_node_fs.constants.O_NOFOLLOW
    );
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) {
      return Object.freeze({ ok: false, reason: "not_regular_file" });
    }
    const [canonicalRoot, canonicalTarget] = await Promise.all([
      (0, import_promises.realpath)(options.rootPath),
      (0, import_promises.realpath)(absolutePath)
    ]);
    const rootRelative = (0, import_node_path.relative)(canonicalRoot, canonicalTarget);
    if (rootRelative === ".." || rootRelative.startsWith(`..${import_node_path.sep}`) || rootRelative.startsWith(import_node_path.sep)) {
      return Object.freeze({ ok: false, reason: "outside_root" });
    }
    const pathIdentity = await (0, import_promises.stat)(canonicalTarget, { bigint: true });
    if (pathIdentity.dev !== before.dev || pathIdentity.ino !== before.ino || !pathIdentity.isFile()) {
      return Object.freeze({ ok: false, reason: "changed_during_read" });
    }
    const byteCount = Number(before.size);
    if (!Number.isSafeInteger(byteCount) || byteCount < 0) {
      return Object.freeze({
        ok: false,
        reason: "too_large",
        byteCount
      });
    }
    if (byteCount > options.maxBytes) {
      return Object.freeze({
        ok: false,
        reason: "too_large",
        byteCount
      });
    }
    const bytes = Buffer.alloc(byteCount);
    if (!await readExact(handle, bytes, options.signal)) {
      return Object.freeze({
        ok: false,
        reason: "changed_during_read",
        byteCount
      });
    }
    throwIfAborted(options.signal);
    const after = await handle.stat({ bigint: true });
    if (!after.isFile() || Number(after.size) !== byteCount || after.dev !== before.dev || after.ino !== before.ino || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) {
      return Object.freeze({
        ok: false,
        reason: "changed_during_read",
        byteCount: Number(after.size)
      });
    }
    return Object.freeze({ ok: true, bytes, byteCount });
  } finally {
    await handle?.close().catch(() => void 0);
  }
}

// src/plugin-sdk/parameters.ts
var PluginParameterError = class extends TypeError {
  code;
  parameter;
  constructor(params) {
    super(params.message ?? `${params.parameter}: ${params.code}`);
    this.name = "PluginParameterError";
    this.code = params.code;
    this.parameter = params.parameter;
  }
};
function isPluginParameterError(error) {
  return error instanceof PluginParameterError;
}
function stringOptions(input) {
  return typeof input === "string" ? { name: input } : input;
}
function parameterName(options) {
  return options.name ?? options.parameter ?? "value";
}
function parseString(value, options) {
  if (value === void 0 || value === null) return void 0;
  const parameter = parameterName(options);
  if (typeof value !== "string") {
    throw new PluginParameterError({
      code: "plugin_parameter_invalid",
      parameter
    });
  }
  const parsed = options.trim === false ? value : value.trim();
  if (options.minLength !== void 0 && parsed.length < options.minLength || options.maxLength !== void 0 && parsed.length > options.maxLength) {
    throw new PluginParameterError({
      code: "plugin_parameter_invalid",
      parameter
    });
  }
  return parsed;
}
function readOptionalString(value, input = {}) {
  return parseString(value, stringOptions(input));
}
function readBoundedInteger(value, options) {
  const parameter = parameterName(options);
  const candidate = value === void 0 ? options.defaultValue : value;
  if (!Number.isSafeInteger(candidate) || candidate < options.minimum || candidate > options.maximum) {
    throw new PluginParameterError({
      code: candidate === void 0 ? "plugin_parameter_required" : "plugin_parameter_invalid",
      parameter
    });
  }
  return candidate;
}

// src/plugin-sdk/paths.ts
function resolvePluginPath(context, rawPath, options = {}) {
  return context.runtimePathResolver.resolve(rawPath, options);
}
function runtimeToolPathErrorCode(error) {
  if (!(error instanceof Error) || !("code" in error) || typeof error.code !== "string" || !error.code.startsWith("runtime_tool_path_")) {
    return void 0;
  }
  return error.code;
}

// src/plugin-sdk/plugin.ts
function defineRuntimePlugin(definition) {
  return definition;
}

// src/plugin-sdk/results.ts
var PLUGIN_RESULT_SERIALIZED_MAX_BYTES = 128 * 1024;
function resultBoundsFailure(code, message) {
  return {
    ok: false,
    output: message,
    producedNewInformation: false,
    error: message,
    errorCode: code
  };
}
function enforcePluginResultByteBudget(result) {
  let serialized;
  try {
    const candidate = JSON.stringify(result);
    if (candidate === void 0) {
      return resultBoundsFailure(
        "plugin_result_not_json_safe",
        "The plugin produced a result that is not JSON-safe."
      );
    }
    serialized = candidate;
  } catch {
    return resultBoundsFailure(
      "plugin_result_not_json_safe",
      "The plugin produced a result that is not JSON-safe."
    );
  }
  if (Buffer.byteLength(serialized, "utf8") > PLUGIN_RESULT_SERIALIZED_MAX_BYTES) {
    return resultBoundsFailure(
      "plugin_result_too_large",
      `The plugin result exceeds the ${PLUGIN_RESULT_SERIALIZED_MAX_BYTES}-byte safety limit.`
    );
  }
  return result;
}
function successResult(input) {
  return enforcePluginResultByteBudget({
    ok: true,
    output: input.output,
    producedNewInformation: input.producedNewInformation ?? true,
    ...input.progress !== void 0 ? { progress: input.progress } : {},
    ...input.actions !== void 0 ? { actions: input.actions } : {},
    ...input.exitCode !== void 0 ? { exitCode: input.exitCode } : {},
    ...input.stdout !== void 0 ? { stdout: input.stdout } : {},
    ...input.stderr !== void 0 ? { stderr: input.stderr } : {},
    ...input.data !== void 0 ? { data: input.data } : {}
  });
}
function failureResult(input) {
  return enforcePluginResultByteBudget({
    ok: false,
    output: input.output ?? input.message,
    producedNewInformation: false,
    ...input.progress !== void 0 ? { progress: input.progress } : {},
    ...input.actions !== void 0 ? { actions: input.actions } : {},
    ...input.exitCode !== void 0 ? { exitCode: input.exitCode } : {},
    ...input.stdout !== void 0 ? { stdout: input.stdout } : {},
    ...input.stderr !== void 0 ? { stderr: input.stderr } : {},
    ...input.data !== void 0 ? { data: input.data } : {},
    error: input.message,
    errorCode: input.errorCode
  });
}
function failureFromError(error, options) {
  const pathCode = runtimeToolPathErrorCode(error);
  const parameterCode = isPluginParameterError(error) ? error.code : void 0;
  const errorCode = pathCode ?? parameterCode ?? options.fallbackCode;
  const message = pathCode ?? parameterCode ?? options.fallbackMessage;
  return failureResult({
    errorCode,
    message,
    output: options.operation ? `${options.operation} failed: ${message}` : message
  });
}

// plugins/document-reader/source/constants.ts
var MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
var DEFAULT_MAX_CHARS = 2e4;
var MAX_CHARS = 4e4;
var MAX_START_CHAR = 1e7;
var MAX_RETAINED_TEXT_CHARS = MAX_START_CHAR + MAX_CHARS;
var MAX_OUTPUT_CHARS = 48e3;
var MAX_OUTPUT_JSON_BYTES = 64 * 1024;
var MAX_IDENTITY_CHARS = 512;
var MAX_ARCHIVE_ENTRIES = 4096;
var MAX_ARCHIVE_DECLARED_BYTES = 256 * 1024 * 1024;
var MAX_XML_ENTRY_BYTES = 8 * 1024 * 1024;
var MAX_TOTAL_XML_BYTES = 24 * 1024 * 1024;
var MAX_PDF_PAGES = 1e4;
var PDF_PAGE_BATCH_SIZE = 1;
var PDF_EXTRACTION_TIMEOUT_MS = 3e4;
var PDF_MAX_OLD_GENERATION_MB = 128;
var PDF_MAX_YOUNG_GENERATION_MB = 16;
var PDF_MAX_STACK_MB = 4;
var MAX_PDF_ERROR_MESSAGE_CHARS = 512;
var EXTENSION_MIME_TYPES = Object.freeze({
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".md": "text/markdown",
  ".json": "application/json",
  ".rtf": "application/rtf"
});
var MIME_TYPE_ALIASES = Object.freeze({
  "application/x-rtf": "application/rtf",
  "text/rtf": "application/rtf",
  "text/x-markdown": "text/markdown"
});

// plugins/document-reader/source/errors.ts
var DocumentReaderError = class extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.name = "DocumentReaderError";
    this.code = code;
  }
};
function failDocument(code, message) {
  throw new DocumentReaderError(code, message);
}
function hasNodeErrorCode(error, code) {
  return error instanceof Error && typeof error.code === "string" && error.code === code;
}
function rethrowDocumentIoError(error) {
  if (error instanceof DocumentReaderError) throw error;
  if (hasNodeErrorCode(error, "ENOENT")) {
    failDocument(
      "document_not_found",
      "The requested document does not exist."
    );
  }
  if (hasNodeErrorCode(error, "EACCES") || hasNodeErrorCode(error, "EPERM")) {
    failDocument(
      "document_access_denied",
      "Access to the requested document was denied."
    );
  }
  if (hasNodeErrorCode(error, "EISDIR")) {
    failDocument(
      "document_target_not_file",
      "The requested document is not a regular file."
    );
  }
  if (hasNodeErrorCode(error, "ABORT_ERR") || error instanceof Error && error.name === "AbortError") {
    failDocument("document_read_cancelled", "Document reading was cancelled.");
  }
  throw error;
}
function documentReaderFailure(error) {
  if (error instanceof DocumentReaderError) {
    return failureResult({
      errorCode: error.code,
      message: error.message,
      output: `read_document failed: ${error.message}`
    });
  }
  return failureFromError(error, {
    fallbackCode: "document_read_failed",
    fallbackMessage: "Document reading failed.",
    operation: "read_document"
  });
}

// plugins/document-reader/source/pdf-worker.ts
var import_node_module = require("node:module");
var import_node_worker_threads = require("node:worker_threads");
var PDF_EXTRACTION_LIMITS = Object.freeze({
  maxPages: MAX_PDF_PAGES,
  pageBatchSize: PDF_PAGE_BATCH_SIZE,
  maxRetainedCharacters: MAX_RETAINED_TEXT_CHARS,
  timeoutMs: PDF_EXTRACTION_TIMEOUT_MS,
  maxOldGenerationSizeMb: PDF_MAX_OLD_GENERATION_MB,
  maxYoungGenerationSizeMb: PDF_MAX_YOUNG_GENERATION_MB,
  stackSizeMb: PDF_MAX_STACK_MB
});
var CONTROLLED_PDF_ERROR_CODES = /* @__PURE__ */ new Set([
  "document_content_invalid",
  "document_pdf_page_limit",
  "document_pdf_resource_limit"
]);
function pdfExtractionWorkerMain() {
  const { parentPort, workerData } = require("node:worker_threads");
  const data = workerData;
  const fail = (code, message) => {
    const error = new Error(message);
    error.code = code;
    throw error;
  };
  const boundedMessage = (value) => {
    const message = value instanceof Error ? value.message : String(value);
    return message.slice(0, data.limits.maxErrorMessageCharacters);
  };
  const run = async () => {
    if (!parentPort) {
      throw new Error("PDF extraction worker has no parent port.");
    }
    let parser;
    try {
      const { PDFParse } = require(data.pdfParseEntrypoint);
      parser = new PDFParse({
        data: new Uint8Array(data.bytes),
        isEvalSupported: false,
        stopAtErrors: true
      });
      const info = await parser.getInfo();
      const totalPages = info.total;
      if (!Number.isSafeInteger(totalPages) || totalPages < 0) {
        fail("document_content_invalid", "The PDF page index is invalid.");
      }
      if (totalPages > data.limits.maxPages) {
        fail(
          "document_pdf_page_limit",
          `The PDF exceeds the ${data.limits.maxPages}-page parsing limit.`
        );
      }
      const retainedParts = [];
      let retainedCharacters = 0;
      let totalCharacters = 0;
      let processedPages = 0;
      let hasContent = false;
      const append = (rawValue) => {
        const value = rawValue.replaceAll("\0", "").trim();
        if (value.length === 0) return;
        const separator = hasContent ? "\n\n" : "";
        hasContent = true;
        const nextTotal = totalCharacters + separator.length + value.length;
        if (!Number.isSafeInteger(nextTotal)) {
          fail(
            "document_pdf_resource_limit",
            "The PDF text exceeds the supported character range."
          );
        }
        totalCharacters = nextTotal;
        let remaining = data.limits.maxRetainedCharacters - retainedCharacters;
        if (remaining <= 0) return;
        if (separator.length > 0) {
          const retainedSeparator = separator.slice(0, remaining);
          retainedParts.push(retainedSeparator);
          retainedCharacters += retainedSeparator.length;
          remaining -= retainedSeparator.length;
        }
        if (remaining > 0) {
          const retainedValue = value.slice(0, remaining);
          retainedParts.push(retainedValue);
          retainedCharacters += retainedValue.length;
        }
      };
      for (let firstPage = 1; firstPage <= totalPages; firstPage += data.limits.pageBatchSize) {
        const pageNumbers = Array.from(
          {
            length: Math.min(
              data.limits.pageBatchSize,
              totalPages - firstPage + 1
            )
          },
          (_, index) => firstPage + index
        );
        const batch = await parser.getText({
          partial: pageNumbers,
          pageJoiner: ""
        });
        if (!Array.isArray(batch.pages)) {
          fail(
            "document_content_invalid",
            "The PDF page set could not be extracted."
          );
        }
        for (const page of batch.pages) {
          if (typeof page?.text !== "string") {
            fail("document_content_invalid", "The PDF page text is invalid.");
          }
          processedPages += 1;
          append(page.text);
        }
      }
      if (processedPages !== totalPages) {
        fail(
          "document_content_invalid",
          "The PDF page set could not be extracted completely."
        );
      }
      parentPort.postMessage({
        kind: "success",
        text: retainedParts.join(""),
        totalCharacters,
        returnedCharacters: retainedCharacters,
        totalPages,
        processedPages
      });
    } catch (error) {
      const candidateCode = error instanceof Error && typeof error.code === "string" ? error.code : void 0;
      parentPort.postMessage({
        kind: "failure",
        ...candidateCode ? { code: candidateCode } : {},
        message: boundedMessage(error)
      });
    } finally {
      if (parser) {
        await parser.destroy().catch(() => void 0);
      }
      parentPort.close();
    }
  };
  void run();
}
function resolvePdfParseEntrypoint(pluginEntrypoint) {
  return (0, import_node_module.createRequire)(pluginEntrypoint).resolve("pdf-parse");
}
function createPdfExtractionWorker(bytes, pdfParseEntrypoint, limits = PDF_EXTRACTION_LIMITS) {
  const transferredBytes = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(transferredBytes).set(bytes);
  return new import_node_worker_threads.Worker(`(${pdfExtractionWorkerMain.toString()})()`, {
    eval: true,
    transferList: [transferredBytes],
    workerData: {
      bytes: transferredBytes,
      pdfParseEntrypoint,
      limits: {
        maxPages: limits.maxPages,
        pageBatchSize: limits.pageBatchSize,
        maxRetainedCharacters: limits.maxRetainedCharacters,
        maxErrorMessageCharacters: MAX_PDF_ERROR_MESSAGE_CHARS
      }
    },
    resourceLimits: {
      maxOldGenerationSizeMb: limits.maxOldGenerationSizeMb,
      maxYoungGenerationSizeMb: limits.maxYoungGenerationSizeMb,
      stackSizeMb: limits.stackSizeMb
    }
  });
}
function isSafeNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && typeof value === "number" && value >= 0;
}
function isPdfWorkerMessage(value) {
  if (!value || typeof value !== "object") return false;
  const candidate = value;
  if (candidate.kind === "failure") {
    return typeof candidate.message === "string" && candidate.message.length <= MAX_PDF_ERROR_MESSAGE_CHARS && (candidate.code === void 0 || typeof candidate.code === "string");
  }
  return candidate.kind === "success" && typeof candidate.text === "string" && isSafeNonNegativeInteger(candidate.totalCharacters) && isSafeNonNegativeInteger(candidate.returnedCharacters) && isSafeNonNegativeInteger(candidate.totalPages) && isSafeNonNegativeInteger(candidate.processedPages);
}
function resourceLimitError(message) {
  return new DocumentReaderError("document_pdf_resource_limit", message);
}
async function extractPdfInWorker(bytes, params) {
  const limits = params.limits ?? PDF_EXTRACTION_LIMITS;
  if (params.signal?.aborted) {
    throw new DocumentReaderError(
      "document_read_cancelled",
      "Document reading was cancelled."
    );
  }
  const worker = createPdfExtractionWorker(
    bytes,
    params.pdfParseEntrypoint,
    limits
  );
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      settle(
        () => reject(
          resourceLimitError(
            `PDF extraction exceeded the ${limits.timeoutMs}-millisecond time limit.`
          )
        ),
        true
      );
    }, limits.timeoutMs);
    timeout.unref();
    const cleanup = () => {
      clearTimeout(timeout);
      params.signal?.removeEventListener("abort", onAbort);
      worker.removeAllListeners();
    };
    const settle = (complete, terminate) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (terminate) void worker.terminate();
      complete();
    };
    const onAbort = () => {
      settle(
        () => reject(
          new DocumentReaderError(
            "document_read_cancelled",
            "Document reading was cancelled."
          )
        ),
        true
      );
    };
    worker.once("message", (message) => {
      if (!isPdfWorkerMessage(message)) {
        settle(
          () => reject(new Error("PDF extraction worker returned invalid data.")),
          true
        );
        return;
      }
      if (message.kind === "failure") {
        settle(() => {
          if (message.code && CONTROLLED_PDF_ERROR_CODES.has(message.code)) {
            reject(new DocumentReaderError(message.code, message.message));
            return;
          }
          reject(new Error(message.message));
        }, true);
        return;
      }
      const validSuccess = message.text.length === message.returnedCharacters && message.returnedCharacters <= limits.maxRetainedCharacters && message.returnedCharacters <= message.totalCharacters && message.totalPages <= limits.maxPages && message.processedPages === message.totalPages;
      if (!validSuccess) {
        settle(
          () => reject(new Error("PDF extraction worker exceeded its contract.")),
          true
        );
        return;
      }
      settle(
        () => resolve(
          Object.freeze({
            text: message.text,
            textBounds: Object.freeze({
              truncated: message.totalCharacters > message.returnedCharacters,
              totalCharacters: message.totalCharacters,
              returnedCharacters: message.returnedCharacters,
              omittedCharacters: message.totalCharacters - message.returnedCharacters,
              maxCharacters: limits.maxRetainedCharacters
            }),
            format: Object.freeze({
              kind: "pdf",
              totalPages: message.totalPages,
              processedPages: message.processedPages,
              maxPages: limits.maxPages
            })
          })
        ),
        true
      );
    });
    worker.once("error", (error) => {
      settle(
        () => reject(
          error.code === "ERR_WORKER_OUT_OF_MEMORY" ? resourceLimitError("PDF extraction exceeded the memory limit.") : error
        ),
        false
      );
    });
    worker.once("exit", (code) => {
      if (code === 0) {
        settle(
          () => reject(new Error("PDF extraction worker exited without a result.")),
          false
        );
        return;
      }
      settle(
        () => reject(
          resourceLimitError(
            "PDF extraction stopped after exceeding a resource limit."
          )
        ),
        false
      );
    });
    params.signal?.addEventListener("abort", onAbort, { once: true });
    if (params.signal?.aborted) onAbort();
  });
}

// plugins/document-reader/source/archive.ts
var import_jszip = __toESM(require("jszip"), 1);
var END_OF_CENTRAL_DIRECTORY_SIGNATURE = 101010256;
var CENTRAL_DIRECTORY_ENTRY_SIGNATURE = 33639248;
var MAX_END_RECORD_SEARCH_BYTES = 65557;
function findEndOfCentralDirectory(bytes, view) {
  if (bytes.byteLength < 22) {
    failDocument("document_archive_invalid", "The OOXML archive is invalid.");
  }
  const minimumOffset = Math.max(
    0,
    bytes.byteLength - MAX_END_RECORD_SEARCH_BYTES
  );
  for (let offset = bytes.byteLength - 22; offset >= minimumOffset; offset -= 1) {
    if (view.getUint32(offset, true) !== END_OF_CENTRAL_DIRECTORY_SIGNATURE) {
      continue;
    }
    const commentLength = view.getUint16(offset + 20, true);
    if (offset + 22 + commentLength === bytes.byteLength) return offset;
  }
  failDocument("document_archive_invalid", "The OOXML archive is invalid.");
}
function validateArchiveDirectory(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const endOffset = findEndOfCentralDirectory(bytes, view);
  const entryCount = view.getUint16(endOffset + 10, true);
  const diskEntryCount = view.getUint16(endOffset + 8, true);
  const directoryBytes = view.getUint32(endOffset + 12, true);
  const directoryOffset = view.getUint32(endOffset + 16, true);
  const diskNumber = view.getUint16(endOffset + 4, true);
  const directoryDisk = view.getUint16(endOffset + 6, true);
  if (diskNumber !== 0 || directoryDisk !== 0 || diskEntryCount !== entryCount || entryCount === 65535 || directoryBytes === 4294967295 || directoryOffset === 4294967295) {
    failDocument(
      "document_archive_unsupported",
      "Multi-disk and ZIP64 OOXML archives are not supported."
    );
  }
  if (entryCount > MAX_ARCHIVE_ENTRIES) {
    failDocument(
      "document_archive_entry_limit",
      `The OOXML archive exceeds the ${MAX_ARCHIVE_ENTRIES}-entry limit.`
    );
  }
  const directoryEnd = directoryOffset + directoryBytes;
  if (directoryEnd > endOffset || directoryEnd > bytes.byteLength) {
    failDocument("document_archive_invalid", "The OOXML archive is invalid.");
  }
  let offset = directoryOffset;
  let declaredUncompressedBytes = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > directoryEnd || view.getUint32(offset, true) !== CENTRAL_DIRECTORY_ENTRY_SIGNATURE) {
      failDocument("document_archive_invalid", "The OOXML archive is invalid.");
    }
    const flags = view.getUint16(offset + 8, true);
    const compressionMethod = view.getUint16(offset + 10, true);
    const compressedBytes = view.getUint32(offset + 20, true);
    const uncompressedBytes = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const entryLength = 46 + nameLength + extraLength + commentLength;
    if (offset + entryLength > directoryEnd || compressedBytes === 4294967295 || uncompressedBytes === 4294967295) {
      failDocument("document_archive_invalid", "The OOXML archive is invalid.");
    }
    if ((flags & 1) !== 0) {
      failDocument(
        "document_archive_unsupported",
        "Encrypted OOXML archive entries are not supported."
      );
    }
    if (compressionMethod !== 0 && compressionMethod !== 8) {
      failDocument(
        "document_archive_unsupported",
        "The OOXML archive uses an unsupported compression method."
      );
    }
    declaredUncompressedBytes += uncompressedBytes;
    if (declaredUncompressedBytes > MAX_ARCHIVE_DECLARED_BYTES) {
      failDocument(
        "document_archive_expansion_limit",
        "The OOXML archive declares more expanded data than the safe parsing limit."
      );
    }
    offset += entryLength;
  }
  if (offset !== directoryEnd) {
    failDocument("document_archive_invalid", "The OOXML archive is invalid.");
  }
  return Object.freeze({
    declaredEntries: entryCount,
    declaredUncompressedBytes
  });
}
async function loadOfficeArchive(bytes) {
  const directory = validateArchiveDirectory(bytes);
  let zip;
  try {
    zip = await import_jszip.default.loadAsync(bytes, { checkCRC32: false });
  } catch {
    failDocument("document_archive_invalid", "The OOXML archive is invalid.");
  }
  return Object.freeze({
    zip,
    directory,
    budget: { expandedXmlBytes: 0, processedXmlEntries: 0 }
  });
}
async function readBoundedXml(entry, budget, signal) {
  if (signal?.aborted) {
    failDocument("document_read_cancelled", "Document reading was cancelled.");
  }
  return new Promise((resolve, reject) => {
    const stream = entry.nodeStream("nodebuffer");
    const chunks = [];
    let entryBytes = 0;
    let settled = false;
    const cleanup = () => {
      signal?.removeEventListener("abort", onAbort);
      stream.removeListener("data", onData);
      stream.removeListener("error", onError);
      stream.removeListener("end", onEnd);
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      stream.destroy();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const onAbort = () => {
      fail(
        new DocumentReaderError(
          "document_read_cancelled",
          "Document reading was cancelled."
        )
      );
    };
    const onData = (chunk) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      entryBytes += buffer.byteLength;
      if (entryBytes > MAX_XML_ENTRY_BYTES || budget.expandedXmlBytes + entryBytes > MAX_TOTAL_XML_BYTES) {
        fail(
          new DocumentReaderError(
            "document_archive_expansion_limit",
            "The OOXML document exceeds the safe expanded-text parsing limit."
          )
        );
        return;
      }
      chunks.push(buffer);
    };
    const onError = (error) => fail(error);
    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      budget.expandedXmlBytes += entryBytes;
      budget.processedXmlEntries += 1;
      resolve(Buffer.concat(chunks, entryBytes).toString("utf8"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    stream.on("data", onData);
    stream.once("error", onError);
    stream.once("end", onEnd);
  });
}
function archiveMetadata(archive) {
  return Object.freeze({
    declaredEntries: archive.directory.declaredEntries,
    declaredUncompressedBytes: archive.directory.declaredUncompressedBytes,
    processedXmlEntries: archive.budget.processedXmlEntries,
    expandedXmlBytes: archive.budget.expandedXmlBytes,
    limits: Object.freeze({
      maxEntries: MAX_ARCHIVE_ENTRIES,
      maxDeclaredUncompressedBytes: MAX_ARCHIVE_DECLARED_BYTES,
      maxXmlEntryBytes: MAX_XML_ENTRY_BYTES,
      maxExpandedXmlBytes: MAX_TOTAL_XML_BYTES
    })
  });
}

// plugins/document-reader/source/text-accumulator.ts
function normalizeExtractedText(value) {
  return value.replaceAll("\0", "").trim();
}
var BoundedTextAccumulator = class {
  #maxCharacters;
  #parts = [];
  #returnedCharacters = 0;
  #totalCharacters = 0;
  #hasContent = false;
  constructor(maxCharacters = MAX_RETAINED_TEXT_CHARS) {
    this.#maxCharacters = maxCharacters;
  }
  append(value, separator = "\n\n") {
    if (value.length === 0) return;
    const combined = this.#hasContent ? separator + value : value;
    this.#hasContent = true;
    this.#totalCharacters += combined.length;
    const remaining = this.#maxCharacters - this.#returnedCharacters;
    if (remaining <= 0) return;
    const retained = combined.slice(0, remaining);
    this.#parts.push(retained);
    this.#returnedCharacters += retained.length;
  }
  finish(format) {
    return Object.freeze({
      text: this.#parts.join(""),
      textBounds: Object.freeze({
        truncated: this.#totalCharacters > this.#returnedCharacters,
        totalCharacters: this.#totalCharacters,
        returnedCharacters: this.#returnedCharacters,
        omittedCharacters: this.#totalCharacters - this.#returnedCharacters,
        maxCharacters: this.#maxCharacters
      }),
      format
    });
  }
};
function extractedTextResult(value, format = Object.freeze({ kind: "text" })) {
  const accumulator = new BoundedTextAccumulator();
  accumulator.append(normalizeExtractedText(value), "");
  return accumulator.finish(format);
}

// plugins/document-reader/source/ooxml.ts
function decodeCodePoint(value, radix) {
  const parsed = Number.parseInt(value, radix);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 1114111) {
    return "�";
  }
  return String.fromCodePoint(parsed);
}
function decodeXml(value) {
  return value.replace(/&#x([0-9a-f]+);/giu, (_, hex) => decodeCodePoint(hex, 16)).replace(/&#(\d+);/gu, (_, decimal) => decodeCodePoint(decimal, 10)).replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&apos;", "'").replaceAll("&amp;", "&");
}
function extractTextNodes(xml, tag) {
  const values = [];
  const pattern = new RegExp(
    `<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`,
    "giu"
  );
  for (const match of xml.matchAll(pattern)) {
    values.push(decodeXml((match[1] ?? "").replace(/<[^>]+>/gu, "")));
  }
  return values;
}
function numericSuffix(name) {
  return Number(name.match(/(\d+)\.xml$/u)?.[1] ?? Number.MAX_SAFE_INTEGER);
}
function archiveResult(accumulator, archive) {
  return accumulator.finish(
    Object.freeze({
      kind: "archive",
      archive: archiveMetadata(archive)
    })
  );
}
async function extractDocxText(bytes, signal) {
  const archive = await loadOfficeArchive(bytes);
  const names = Object.keys(archive.zip.files).filter(
    (name) => /^word\/(?:document|header\d+|footer\d+|footnotes|endnotes)\.xml$/u.test(
      name
    )
  ).sort(
    (left, right) => left === "word/document.xml" ? -1 : right === "word/document.xml" ? 1 : left.localeCompare(right)
  );
  const accumulator = new BoundedTextAccumulator();
  for (const name of names) {
    const entry = archive.zip.file(name);
    if (!entry) continue;
    const xml = await readBoundedXml(entry, archive.budget, signal);
    const normalized = xml.replace(/<w:tab\b[^>]*\/>/giu, "	").replace(/<w:br\b[^>]*\/>/giu, "\n").replace(/<\/w:tc>/giu, "	").replace(/<\/w:p>/giu, "\n");
    const text = normalizeExtractedText(
      decodeXml(
        normalized.replace(/<(?!\/?w:t\b)[^>]+>/giu, "").replace(/<\/?w:t\b[^>]*>/giu, "")
      ).replace(/[ \t]+\n/gu, "\n").replace(/\n{3,}/gu, "\n\n")
    );
    accumulator.append(text);
  }
  return archiveResult(accumulator, archive);
}
async function extractPptxText(bytes, signal) {
  const archive = await loadOfficeArchive(bytes);
  const names = Object.keys(archive.zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/u.test(name)).sort((left, right) => numericSuffix(left) - numericSuffix(right));
  const accumulator = new BoundedTextAccumulator();
  for (const [index, name] of names.entries()) {
    const entry = archive.zip.file(name);
    if (!entry) continue;
    const xml = await readBoundedXml(entry, archive.budget, signal);
    const content = normalizeExtractedText(
      extractTextNodes(xml, "a:t").filter(Boolean).join("\n")
    );
    accumulator.append(`[Slide ${index + 1}]${content ? `
${content}` : ""}`);
  }
  return archiveResult(accumulator, archive);
}
function cellValue(attributes, body, sharedStrings) {
  const type = attributes.match(/\bt="([^"]+)"/u)?.[1];
  const rawValue = body.match(/<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/iu)?.[1];
  if (type === "s" && rawValue !== void 0) {
    const index = Number(rawValue);
    return Number.isSafeInteger(index) && index >= 0 ? sharedStrings[index] ?? rawValue : rawValue;
  }
  if (type === "inlineStr") return extractTextNodes(body, "t").join("");
  return decodeXml(rawValue ?? "");
}
async function extractXlsxText(bytes, signal) {
  const archive = await loadOfficeArchive(bytes);
  const sharedStrings = [];
  const sharedEntry = archive.zip.file("xl/sharedStrings.xml");
  if (sharedEntry) {
    const sharedXml = await readBoundedXml(sharedEntry, archive.budget, signal);
    for (const match of sharedXml.matchAll(
      /<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/giu
    )) {
      sharedStrings.push(extractTextNodes(match[1] ?? "", "t").join(""));
    }
  }
  const sheetNames = Object.keys(archive.zip.files).filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/u.test(name)).sort((left, right) => numericSuffix(left) - numericSuffix(right));
  const accumulator = new BoundedTextAccumulator();
  for (const [index, name] of sheetNames.entries()) {
    const entry = archive.zip.file(name);
    if (!entry) continue;
    const xml = await readBoundedXml(entry, archive.budget, signal);
    const rows = [];
    for (const rowMatch of xml.matchAll(
      /<row(?:\s[^>]*)?>([\s\S]*?)<\/row>/giu
    )) {
      const cells = [];
      for (const cellMatch of (rowMatch[1] ?? "").matchAll(
        /<c([^>]*)>([\s\S]*?)<\/c>/giu
      )) {
        cells.push(
          cellValue(cellMatch[1] ?? "", cellMatch[2] ?? "", sharedStrings)
        );
      }
      rows.push(cells.join("	"));
    }
    const content = normalizeExtractedText(rows.join("\n"));
    accumulator.append(`[Sheet ${index + 1}]${content ? `
${content}` : ""}`);
  }
  return archiveResult(accumulator, archive);
}

// plugins/document-reader/source/pdf.ts
function extractPdfText(bytes, pdfParseEntrypoint, signal) {
  return extractPdfInWorker(bytes, {
    pdfParseEntrypoint,
    ...signal ? { signal } : {}
  });
}

// plugins/document-reader/source/extract.ts
function extractRtfText(source) {
  return source.replace(
    /\\'[0-9a-f]{2}/giu,
    (value) => String.fromCharCode(Number.parseInt(value.slice(2), 16))
  ).replace(/\\[a-z]+-?\d* ?/giu, "").replace(/[{}]/gu, "");
}
async function extractDocumentText(document, bytes, pdfParseEntrypoint, signal) {
  switch (document.mimeType) {
    case "application/pdf":
      return extractPdfText(bytes, pdfParseEntrypoint, signal);
    case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
      return extractDocxText(bytes, signal);
    case "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
      return extractXlsxText(bytes, signal);
    case "application/vnd.openxmlformats-officedocument.presentationml.presentation":
      return extractPptxText(bytes, signal);
    case "application/json": {
      try {
        const parsed = JSON.parse(
          Buffer.from(bytes).toString("utf8")
        );
        return extractedTextResult(JSON.stringify(parsed, null, 2));
      } catch {
        failDocument(
          "document_content_invalid",
          "The requested JSON document is invalid."
        );
      }
    }
    case "application/rtf":
      return extractedTextResult(
        extractRtfText(Buffer.from(bytes).toString("utf8"))
      );
    case "text/plain":
    case "text/csv":
    case "text/markdown":
      return extractedTextResult(Buffer.from(bytes).toString("utf8"));
  }
}

// plugins/document-reader/source/reader.ts
async function readDocument(document, pdfParseEntrypoint, signal) {
  try {
    const file = await readBoundedRegularFile(document.absolutePath, {
      maxBytes: MAX_DOCUMENT_BYTES,
      rootPath: document.rootPath,
      ...signal ? { signal } : {}
    });
    if (!file.ok && file.reason === "not_regular_file") {
      failDocument(
        "document_target_not_file",
        "The requested document is not a regular file."
      );
    }
    if (!file.ok && file.reason === "too_large") {
      failDocument(
        "document_file_too_large",
        `The requested document exceeds the ${MAX_DOCUMENT_BYTES}-byte parsing limit.`
      );
    }
    if (!file.ok) {
      failDocument(
        "document_changed_during_read",
        "The requested document changed while it was being read."
      );
    }
    const bytes = new Uint8Array(file.bytes);
    return Object.freeze({
      bytes: bytes.byteLength,
      extracted: await extractDocumentText(
        document,
        bytes,
        pdfParseEntrypoint,
        signal
      )
    });
  } catch (error) {
    rethrowDocumentIoError(error);
  }
}

// plugins/document-reader/source/source-resolution.ts
var import_node_path2 = require("node:path");
var SUPPORTED_MIME_TYPES = new Set(
  Object.values(EXTENSION_MIME_TYPES)
);
function supportedMimeType(value) {
  const normalized = value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  const alias = MIME_TYPE_ALIASES[normalized] ?? normalized;
  return SUPPORTED_MIME_TYPES.has(alias) ? alias : void 0;
}
function mimeTypeFromName(value) {
  return EXTENSION_MIME_TYPES[(0, import_node_path2.extname)(value).toLowerCase()];
}
function attachmentDisplayName(attachment) {
  const candidate = attachment.name?.trim() || attachment.id;
  return import_node_path2.posix.basename(import_node_path2.win32.basename(candidate));
}
function attachmentMimeType(attachment) {
  const displayName = attachmentDisplayName(attachment);
  const mimeType = supportedMimeType(attachment.mimeType) ?? mimeTypeFromName(displayName);
  if (!mimeType) {
    failDocument(
      "document_type_unsupported",
      "The requested attachment has an unsupported document type."
    );
  }
  return mimeType;
}
function resolveAttachment(source, attachments) {
  const exactId = attachments.find((attachment) => attachment.id === source);
  if (exactId) return exactId;
  const byName = attachments.filter((attachment) => attachment.name === source);
  if (byName.length > 1) {
    failDocument(
      "document_attachment_ambiguous",
      "Multiple request attachments share that name; use the attachment id."
    );
  }
  return byName[0];
}
function resolveRuntimePathDocument(rawPath, loadContext, executionContext) {
  const runtimePathResolver = executionContext?.runtimePathResolver ?? loadContext.runtimePathResolver;
  const target = resolvePluginPath({ runtimePathResolver }, rawPath, {
    requirePath: true,
    allowedLocations: ["agent_work", "workspace"]
  });
  const mimeType = mimeTypeFromName(target.logicalPath);
  if (!mimeType) {
    failDocument(
      "document_type_unsupported",
      "The requested path has an unsupported document type."
    );
  }
  return Object.freeze({
    kind: "runtime_path",
    absolutePath: target.absolutePath,
    rootPath: target.rootPath,
    displayName: (0, import_node_path2.basename)(target.logicalPath),
    mimeType,
    path: Object.freeze({
      location: target.location,
      logicalPath: target.logicalPath
    })
  });
}
function resolveDocumentReference(params) {
  if (params.sourceMode === "working_path") {
    return resolveRuntimePathDocument(
      params.workingPath,
      params.loadContext,
      params.executionContext
    );
  }
  const attachment = resolveAttachment(
    params.source,
    params.executionContext?.sharedState?.requestAttachments ?? []
  );
  if (!attachment) {
    return resolveRuntimePathDocument(
      params.source,
      params.loadContext,
      params.executionContext
    );
  }
  return Object.freeze({
    kind: "attachment",
    absolutePath: attachment.absolutePath,
    rootPath: params.loadContext.runtimePaths.attachmentsDir,
    attachmentId: attachment.id,
    displayName: attachmentDisplayName(attachment),
    mimeType: attachmentMimeType(attachment)
  });
}

// plugins/document-reader/source/handler.ts
function parseSourceMode(value) {
  if (value === void 0) return "source";
  if (value === "source" || value === "working_path") return value;
  failDocument(
    "document_source_mode_invalid",
    "Document source_mode must be source or working_path."
  );
}
function parseInput(params) {
  const sourceMode = parseSourceMode(params.source_mode);
  const startChar = readBoundedInteger(params.start_char, {
    defaultValue: 0,
    minimum: 0,
    maximum: MAX_START_CHAR,
    name: "start_char"
  });
  const maxChars = readBoundedInteger(params.max_chars, {
    defaultValue: DEFAULT_MAX_CHARS,
    minimum: 1e3,
    maximum: MAX_CHARS,
    name: "max_chars"
  });
  if (sourceMode === "source") {
    const source = readOptionalString(params.source, {
      name: "source",
      maxLength: 4096
    });
    if (!source) {
      failDocument(
        "document_source_required",
        "Document reader requires an attachment id, attachment name, or configured-root path."
      );
    }
    return Object.freeze({ sourceMode, source, startChar, maxChars });
  }
  const workingPath = readOptionalString(params.path, {
    name: "path",
    maxLength: 4096
  });
  if (!workingPath) {
    failDocument(
      "document_path_required",
      "Document reader requires an explicit current-execution path."
    );
  }
  return Object.freeze({ sourceMode, workingPath, startChar, maxChars });
}
function singleLineIdentity(value) {
  const normalized = value.replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s{2,}/gu, " ").trim();
  return normalized.length > MAX_IDENTITY_CHARS ? `${normalized.slice(0, MAX_IDENTITY_CHARS - 1)}…` : normalized;
}
function identityLines(document) {
  const displayName = singleLineIdentity(document.displayName);
  return document.kind === "attachment" ? [
    `Document: ${displayName}`,
    `Attachment id: ${singleLineIdentity(document.attachmentId)}`
  ] : [
    `Document: ${displayName}`,
    `Path: ${singleLineIdentity(document.path.logicalPath)}`
  ];
}
function sourceData(document) {
  return document.kind === "attachment" ? Object.freeze({
    sourceKind: "attachment",
    attachmentId: document.attachmentId
  }) : Object.freeze({
    sourceKind: "runtime_path",
    location: document.path.location,
    path: document.path.logicalPath
  });
}
function eventMetadata(document) {
  return document.kind === "runtime_path" ? Object.freeze({ path: document.path.logicalPath }) : void 0;
}
function actionTarget(document) {
  return sanitizeJsonText(
    document.kind === "attachment" ? `attachment:${document.attachmentId}` : document.path.logicalPath
  );
}
function renderWindow(document, text, startChar, endChar, totalCharacters) {
  const truncated = endChar < totalCharacters;
  return [
    ...identityLines(document),
    `MIME: ${document.mimeType}`,
    `Coverage: characters ${startChar}-${endChar} of ${totalCharacters}${truncated ? " (partial)" : " (complete)"}`,
    ...truncated ? [`Next start_char: ${endChar}`] : [],
    "Content:",
    sanitizeJsonText(text.slice(startChar, endChar)) || "[no extractable text]"
  ].join("\n");
}
function selectBoundedWindow(document, text, startChar, requestedEndChar, totalCharacters) {
  let lower = startChar;
  let upper = requestedEndChar;
  let endChar = startChar;
  let rendered = renderWindow(
    document,
    text,
    startChar,
    startChar,
    totalCharacters
  );
  while (lower <= upper) {
    const candidateEnd = lower + Math.floor((upper - lower) / 2);
    const candidate = renderWindow(
      document,
      text,
      startChar,
      candidateEnd,
      totalCharacters
    );
    const withinBounds = candidate.length <= MAX_OUTPUT_CHARS && Buffer.byteLength(JSON.stringify(candidate), "utf8") <= MAX_OUTPUT_JSON_BYTES;
    if (withinBounds) {
      endChar = candidateEnd;
      rendered = candidate;
      lower = candidateEnd + 1;
    } else {
      upper = candidateEnd - 1;
    }
  }
  return Object.freeze({ endChar, rendered });
}
function createDocumentReaderHandler(loadContext) {
  const pdfParseEntrypoint = resolvePdfParseEntrypoint(loadContext.path);
  return async (params, executionContext) => {
    try {
      const input = parseInput(params);
      const document = resolveDocumentReference({
        ...input,
        loadContext,
        executionContext
      });
      const read = await readDocument(
        document,
        pdfParseEntrypoint,
        executionContext?.abortSignal
      );
      const totalCharacters = read.extracted.textBounds.totalCharacters;
      const startChar = Math.min(input.startChar, totalCharacters);
      const requestedEndChar = Math.min(
        read.extracted.text.length,
        startChar + input.maxChars
      );
      const { endChar, rendered } = selectBoundedWindow(
        document,
        read.extracted.text,
        startChar,
        requestedEndChar,
        totalCharacters
      );
      const content = read.extracted.text.slice(startChar, endChar);
      const truncated = endChar < totalCharacters;
      const output = boundText(rendered, {
        maxChars: MAX_OUTPUT_CHARS,
        marker: "\n[document output truncated]"
      });
      const eventMeta = eventMetadata(document);
      return successResult({
        output: output.text,
        producedNewInformation: true,
        actions: [
          {
            type: "inspect_target",
            target: actionTarget(document),
            details: "read_document"
          }
        ],
        data: {
          ...sourceData(document),
          ...eventMeta ? { eventMeta } : {},
          hasData: totalCharacters > 0,
          itemCount: totalCharacters > 0 ? 1 : 0,
          mimeType: document.mimeType,
          inputBytes: read.bytes,
          totalCharacters,
          startChar,
          endChar,
          truncated,
          limits: {
            maxInputBytes: MAX_DOCUMENT_BYTES,
            maxStartChar: MAX_START_CHAR,
            maxWindowChars: MAX_CHARS,
            maxOutputChars: MAX_OUTPUT_CHARS,
            maxOutputJsonBytes: MAX_OUTPUT_JSON_BYTES
          },
          truncation: {
            extractedText: read.extracted.textBounds,
            window: {
              truncated,
              requestedStartChar: input.startChar,
              returnedStartChar: startChar,
              returnedEndChar: endChar,
              returnedCharacters: content.length,
              omittedAfterWindow: Math.max(totalCharacters - endChar, 0)
            },
            output: output.metadata
          },
          extraction: read.extracted.format,
          observationMeta: { kind: "stable_fact", carryPolicy: "always" }
        }
      });
    } catch (error) {
      return documentReaderFailure(error);
    }
  };
}

// plugins/document-reader/source/index.ts
var index_default = defineRuntimePlugin(
  (context) => Object.freeze({
    handlers: Object.freeze({
      document_reader: createDocumentReaderHandler(context)
    })
  })
);
