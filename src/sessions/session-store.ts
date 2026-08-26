import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import type { SessionRecord } from "./types.js";

function getSessionFilePath(sessionsDir: string, sessionId: string): string {
  return join(sessionsDir, `${sessionId}.json`);
}

export async function ensureSessionsDir(sessionsDir: string): Promise<void> {
  await mkdir(sessionsDir, { recursive: true });
}

export async function loadSessionFile(
  sessionsDir: string,
  sessionId: string,
): Promise<SessionRecord | null> {
  const filePath = getSessionFilePath(sessionsDir, sessionId);
  try {
    const data = await readFile(filePath, "utf-8");
    return JSON.parse(data) as SessionRecord;
  } catch (error: any) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export async function saveSessionFile(
  sessionsDir: string,
  session: SessionRecord,
): Promise<void> {
  const filePath = getSessionFilePath(sessionsDir, session.id);
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tempPath, JSON.stringify(session, null, 2), "utf-8");
    await rename(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function deleteSessionFile(
  sessionsDir: string,
  sessionId: string,
): Promise<boolean> {
  const filePath = getSessionFilePath(sessionsDir, sessionId);
  try {
    await rm(filePath);
    return true;
  } catch (error: any) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export async function loadAllSessionFiles(
  sessionsDir: string,
): Promise<SessionRecord[]> {
  await ensureSessionsDir(sessionsDir);
  const names = await readdir(sessionsDir);
  const sessionFiles = names.filter((name) => name.endsWith(".json"));
  const sessions: SessionRecord[] = [];
  for (const fileName of sessionFiles) {
    const sessionId = fileName.slice(0, -5);
    const session = await loadSessionFile(sessionsDir, sessionId);
    if (session) {
      sessions.push(session);
    }
  }
  return sessions;
}
