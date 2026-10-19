import { randomUUID } from "node:crypto";
import { closeSync, fstatSync, openSync, readFileSync } from "node:fs";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { withFileLock } from "../adapters/long-term-memory/file-lock.js";
import { fileSystemErrorCode } from "../adapters/long-term-memory/file-lock/contracts.js";
import { KnowledgeSkillError, PERSONAL_SKILL_LIMITS, type PersonalSkillRecord } from "./personal-contracts.js";
import { parsePersonalSkillSnapshot } from "./personal-documents.js";

/** Runtime-owned storage; no model-provided paths and no packaged-document writes. */
export function createPersonalSkillRepository(directory: string) {
  const file = join(directory, "personal.json");
  function read(): readonly PersonalSkillRecord[] {
    let descriptor: number | undefined;
    try {
      descriptor = openSync(file, "r");
      if (fstatSync(descriptor).size > PERSONAL_SKILL_LIMITS.storeBytes)
        throw new KnowledgeSkillError("knowledge_skill_storage_too_large");
      const text = readFileSync(descriptor, "utf8");
      try { return parsePersonalSkillSnapshot(JSON.parse(text)); }
      catch { throw new KnowledgeSkillError("knowledge_skill_storage_invalid"); }
    } catch (error) {
      if (fileSystemErrorCode(error) === "ENOENT") return [];
      if (error instanceof KnowledgeSkillError) throw error;
      throw new KnowledgeSkillError("knowledge_skill_storage_unavailable");
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  }
  async function write(documents: readonly PersonalSkillRecord[]) {
    const content = JSON.stringify({ schemaVersion: 2, skills: documents });
    if (Buffer.byteLength(content, "utf8") > PERSONAL_SKILL_LIMITS.storeBytes)
      throw new KnowledgeSkillError("knowledge_skill_storage_too_large");
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporary, "wx", 0o600);
      try { await handle.writeFile(content, "utf8"); await handle.sync(); }
      finally { await handle.close(); }
      await rename(temporary, file);
    } finally { await rm(temporary, { force: true }); }
  }
  return Object.freeze({
    read,
    async update(change: (documents: readonly PersonalSkillRecord[]) => readonly PersonalSkillRecord[]) {
      try {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        return await withFileLock(join(directory, "personal.lock"), async () => {
          const next = change(read());
          await write(next);
          return next;
        });
      } catch (error) {
        if (error instanceof KnowledgeSkillError) throw error;
        throw new KnowledgeSkillError("knowledge_skill_storage_unavailable");
      }
    },
  });
}
