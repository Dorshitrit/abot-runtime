import { lstat, mkdtemp, link, rm, rmdir } from "node:fs/promises";
import { resolve, dirname, join, basename, isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import { LIMITS, requireValue, type Release, type Downloader } from "./contracts.js";
import { downloadRelease } from "./download.js";
import { extractArchive, type ExtractionResult } from "./archive.js";
import { canonicalManagedDirectory as canonicalDirectory, claimCreatedManagedPath, createPrivateManagedDirectory, createManagedFile, openManagedRead, verifyPrivateManagedFile } from "./host-files.js";

export interface InstalledLlama {
  executable: string;
  release: Release;
  extraction: ExtractionResult;
}
type Receipt = { schema: 1; directory: string; release: Release; extraction: ExtractionResult };
const queues = new Map<string, Promise<unknown>>();
function serialize<T>(key: string, work: () => Promise<T>): Promise<T> {
  const result = (queues.get(key) ?? Promise.resolve()).catch(() => {}).then(work);
  queues.set(key, result);
  void result.finally(() => { if (queues.get(key) === result) queues.delete(key); }).catch(() => {});
  return result;
}
function check(value: unknown, message: string): asserts value {
  requireValue(value, "invalid_installation", message);
}
function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}
async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (error) { if (missing(error)) return false; throw error; }
}
function relativeFile(value: unknown): asserts value is string {
  check(typeof value === "string" && value.length > 0 && value.length <= 4096 && !isAbsolute(value) && !/[\\:\u0000-\u001f\u007f]/u.test(value) && value.split("/").every(part => part !== "" && part !== "." && part !== ".."), "Invalid executable relative path.");
}
function identity(release: Release): string {
  return JSON.stringify([release.tag, release.name, release.url, release.size, release.sha256]);
}
async function regularExecutable(path: string): Promise<void> {
  const file = await openManagedRead(path);
  try {
    const stat = await file.stat();
    await verifyPrivateManagedFile(path, stat);
    check(stat.size > 0 && (process.platform === "win32" || (stat.mode & 0o111) !== 0), "Expected an owned regular executable.");
  } finally { await file.close(); }
}
/** Bound even a downloader which ignores cancellation. Detached network promises
 * never write files; downloader implementations still must honor the signal to
 * release their own resources. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((yes, no) => {
    const abort = () => no(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(yes, no).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}
async function verifiedDownload(release: Release, downloader: Downloader, caller?: AbortSignal): Promise<Buffer> {
  const control = new AbortController();
  const abort = () => control.abort(caller?.reason);
  caller?.addEventListener("abort", abort, { once: true });
  if (caller?.aborted) abort();
  const timer = setTimeout(() => control.abort(new Error("Release download timed out.")), LIMITS.downloadMs);
  let iterator: AsyncIterator<Uint8Array> | undefined;
  try {
    control.signal.throwIfAborted();
    const stream = await abortable(Promise.resolve().then(() => downloader(release, control.signal)), control.signal);
    iterator = stream[Symbol.asyncIterator]();
    const hash = createHash("sha256");
    const chunks: Buffer[] = [];
    let bytes = 0;
    for (;;) {
      const item = await abortable(Promise.resolve().then(() => iterator!.next()), control.signal);
      control.signal.throwIfAborted();
      if (item.done) break;
      check(item.value instanceof Uint8Array, "Downloader yielded non-byte data.");
      bytes += item.value.byteLength;
      check(bytes <= release.size, "Release exceeds pinned byte size.");
      const chunk = Buffer.from(item.value);
      hash.update(chunk);
      chunks.push(chunk);
    }
    check(bytes === release.size && hash.digest("hex") === release.sha256, "Release size or SHA256 mismatch.");
    return Buffer.concat(chunks, bytes);
  } finally {
    clearTimeout(timer);
    caller?.removeEventListener("abort", abort);
    control.abort();
    // Do not let a non-cooperative iterator prevent cancellation or mask errors.
    if (iterator?.return) void Promise.resolve().then(() => iterator!.return!()).catch(() => {});
  }
}

/** Storage contract: supply a dedicated absolute canonical private directory,
 * exclusively owned by this application (including control of its ancestors).
 * The parent must already exist. Only explicit install may create storage.
 * Construction/import do no IO. No pre-existing content is removed or adopted.
 *
 * Publication is an exclusive hard link of a complete receipt, NOT directory
 * rename (portable rename can overwrite an empty directory). Its version-specific
 * name atomically makes a unique complete payload visible to inspect. The payload
 * retains its unique name after publication. Readers must use inspect, not scan.
 * Crash leftovers are deliberately not recovered/deleted here. Atomic visibility
 * is provided, not a power-loss durability guarantee. No cross-process waiting:
 * competing publishers fail safely at the exclusive link; they cannot overwrite.
 */
export class LlamaInstaller {
  private readonly root: string;
  private readonly release: Release;
  private readonly key: string;
  constructor(storageDirectory: string, release: Release, private readonly downloader: Downloader = downloadRelease) {
    check(isAbsolute(storageDirectory) && resolve(storageDirectory) === storageDirectory && storageDirectory !== dirname(storageDirectory), "Supply a dedicated canonical absolute storage path.");
    check(/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u.test(release.tag) && typeof release.name === "string" && release.name.length > 0 && release.name.length <= 512 && typeof release.url === "string" && release.url.length <= 4096 && Number.isSafeInteger(release.size) && release.size > 0 && release.size <= LIMITS.expandedBytes && /^[a-f0-9]{64}$/u.test(release.sha256), "Invalid pinned release.");
    this.root = storageDirectory;
    this.release = Object.freeze({ tag: release.tag, name: release.name, url: release.url, size: release.size, sha256: release.sha256 });
    this.key = release.tag + "-" + createHash("sha256").update(identity(this.release)).digest("hex");
  }
  /** Receipt inspection binds identity/digest/path and checks a regular executable.
   * It does NOT rehash installed bytes, attest runtime compatibility or defend
   * against tampering by the owning user. Only install verifies archive SHA256.
   * Missing publication returns null; corrupt/untrusted existing content throws. */
  inspect(): Promise<InstalledLlama | null> {
    return serialize(this.root, () => this.inspectUnlocked());
  }
  private async inspectUnlocked(): Promise<InstalledLlama | null> {
    if (!(await exists(this.root))) {
      await canonicalDirectory(dirname(this.root));
      return null;
    }
    await canonicalDirectory(this.root, true);
    const publication = join(this.root, this.key + ".json");
    if (!(await exists(publication))) return null;
    const file = await openManagedRead(publication);
    let receipt: Receipt;
    try {
      const stat = await file.stat();
      await verifyPrivateManagedFile(publication, stat);
      check(stat.size > 0 && stat.size <= 32768, "Invalid receipt file.");
      const bytes = Buffer.alloc(stat.size + 1);
      let length = 0;
      while (length < bytes.length) {
        const read = await file.read(bytes, length, bytes.length - length, length);
        if (!read.bytesRead) break;
        length += read.bytesRead;
      }
      check(length === stat.size, "Receipt changed while reading.");
      receipt = JSON.parse(bytes.subarray(0, length).toString("utf8")) as Receipt;
    } finally { await file.close(); }
    check(receipt?.schema === 1 && receipt.release && identity(receipt.release) === identity(this.release), "Receipt release mismatch.");
    check(typeof receipt.directory === "string" && receipt.directory.startsWith(this.key + "-") && /^[A-Za-z0-9._-]+$/u.test(receipt.directory) && basename(receipt.directory) === receipt.directory, "Invalid payload directory.");
    const extraction = receipt.extraction;
    check(extraction && extraction.coverage === "complete archive" && Array.isArray(extraction.unresolvedParsingExceptions) && extraction.unresolvedParsingExceptions.length === 0, "Incomplete extraction receipt.");
    for (const field of ["parsedRecords", "files", "directories", "symlinks", "expandedBytes", "fileBytes"] as const) {
      check(Number.isSafeInteger(extraction[field]) && extraction[field] >= 0 && extraction[field] <= LIMITS.expandedBytes, "Invalid extraction counts.");
    }
    check(extraction.parsedRecords > 0 && extraction.parsedRecords <= LIMITS.files && extraction.files > 0 && extraction.parsedRecords === extraction.files + extraction.directories + extraction.symlinks, "Invalid archive coverage counts.");
    relativeFile(extraction.executable);
    check(basename(extraction.executable) === (this.release.name.endsWith(".zip") ? "llama-server.exe" : "llama-server"), "Unexpected executable name.");
    const payload = join(this.root, receipt.directory);
    await canonicalDirectory(payload, true);
    const executable = join(payload, "payload", extraction.executable);
    await regularExecutable(executable);
    return { executable, release: this.release, extraction };
  }
  install(signal?: AbortSignal): Promise<InstalledLlama> {
    return serialize(this.root, async () => {
      signal?.throwIfAborted();
      const installed = await this.inspectUnlocked();
      if (installed) return installed;
      const createdRoot = !(await exists(this.root));
      if (createdRoot) await createPrivateManagedDirectory(this.root);
      let staging: string | undefined;
      let published = false;
      let failed = false;
      try {
        await canonicalDirectory(this.root, true);
        staging = await mkdtemp(join(this.root, this.key + "-"));
        try { await claimCreatedManagedPath(staging, true); }
        catch (error) {
          // A failed claim permits only empty-directory cleanup, never recursion.
          await rmdir(staging).catch(() => {});
          staging = undefined;
          if (createdRoot) await rmdir(this.root).catch(() => {});
          throw error;
        }
        await canonicalDirectory(staging, true);
        const archive = await verifiedDownload(this.release, this.downloader, signal);
        const extractionSignal = signal ?? new AbortController().signal;
        extractionSignal.throwIfAborted();
        const payload = join(staging, "payload");
        await createPrivateManagedDirectory(payload);
        const extraction = await extractArchive((async function* () { yield archive; })(), payload, extractionSignal, this.release.name.endsWith(".zip") ? "zip" : "tar.gz");
        relativeFile(extraction.executable);
        await regularExecutable(join(payload, extraction.executable));
        const receipt: Receipt = { schema: 1, directory: basename(staging), release: this.release, extraction };
        const receiptPath = join(staging, "receipt.json");
        const file = await createManagedFile(receiptPath);
        try { await file.writeFile(JSON.stringify(receipt) + "\n"); } finally { await file.close(); }
        extractionSignal.throwIfAborted();
        await canonicalDirectory(this.root, true);
        // link fails for ALL existing destinations, including symlinks/directories.
        await link(receiptPath, join(this.root, this.key + ".json"));
        published = true;
        return { executable: join(payload, extraction.executable), release: this.release, extraction };
      } catch (error) {
        failed = true;
        throw error;
      } finally {
        if (!published) {
          try {
            await canonicalDirectory(this.root, true);
            if (staging) {
              await canonicalDirectory(staging, true);
              await rm(staging, { recursive: true });
            }
            // A failed first install must not leave an unclaimed empty root that
            // a fresh service rejects. Never remove a pre-existing/nonempty root.
            if (createdRoot) await rmdir(this.root);
          } catch (cleanupError) {
            // Never replace the original download, validation or extraction error.
            if (!failed) throw cleanupError;
          }
        }
      }
    });
  }
}
