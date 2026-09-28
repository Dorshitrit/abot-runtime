import { execFile } from "node:child_process";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import type {
  LockRecord,
  LockSnapshot,
} from "../../runtime/adapters/long-term-memory/file-lock/contracts.js";
import { readLockSnapshot } from "../../runtime/adapters/long-term-memory/file-lock/snapshot.js";
import {
  hasSameProcessOwnerIdentity,
  isProcessOwnerAlive,
  readProcessOwnerIdentity,
} from "./process-owner-identity.js";

const executeFile = promisify(execFile);
const STOP_WAIT_MS = 10_000;

export type NativeReplacementDependencies = Readonly<{
  platform: NodeJS.Platform;
  currentPid: number;
  readLock: typeof readLockSnapshot;
  readIdentity: typeof readProcessOwnerIdentity;
  isAlive: typeof isProcessOwnerAlive;
  signal(pid: number, signal: "SIGTERM"): void;
  execute(
    file: string,
    args: readonly string[],
    options: {
      windowsHide: true;
      timeout: number;
      maxBuffer: number;
    },
  ): Promise<void>;
  now(): number;
  delay(milliseconds: number): Promise<void>;
}>;

function replacementFailure(reason: string): Error {
  return new Error(
    `The running Host Companion could not be safely replaced (${reason}). Close the existing Host Companion, then run the updated setup again. The saved pairing was not changed.`,
  );
}

async function readReplacementLock(
  path: string,
  dependencies: NativeReplacementDependencies,
) {
  try {
    return await dependencies.readLock(path);
  } catch {
    throw replacementFailure("ownership lock unreadable");
  }
}

function requireRecordedOwner(snapshot: LockSnapshot): LockRecord {
  if (snapshot.kind !== "directory")
    throw replacementFailure("legacy ownership lock");
  if (!snapshot.record)
    throw replacementFailure("ownership record unavailable");
  return snapshot.record;
}

function isReclaimableLockWithoutRecord(snapshot: LockSnapshot): boolean {
  if (snapshot.kind !== "directory") return false;
  if (!snapshot.reclaimable) return false;
  return snapshot.record === undefined;
}

function isSameCompanionOwner(
  snapshot: LockSnapshot,
  owner: LockRecord,
): boolean {
  if (snapshot.kind !== "directory") return false;
  if (!snapshot.record) return false;
  if (snapshot.record.pid !== owner.pid) return false;
  if (snapshot.record.token !== owner.token) return false;
  return snapshot.record.ownerIdentity === owner.ownerIdentity;
}

async function verifyLiveCompanionOwner(
  owner: LockRecord,
  dependencies: NativeReplacementDependencies,
): Promise<boolean> {
  if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0)
    throw replacementFailure("invalid owner PID");
  if (owner.pid === dependencies.currentPid)
    throw replacementFailure("setup owns the companion lock");
  if (!(await dependencies.isAlive(owner.pid))) return false;
  if (!owner.ownerIdentity)
    throw replacementFailure("process identity unavailable");
  const observed = await dependencies.readIdentity(owner.pid);
  if (!observed) throw replacementFailure("process identity unreadable");
  if (!hasSameProcessOwnerIdentity(owner.ownerIdentity, observed))
    throw replacementFailure("process identity changed");
  return true;
}

async function stopCompanionProcess(
  owner: LockRecord,
  dependencies: NativeReplacementDependencies,
): Promise<void> {
  try {
    if (dependencies.platform === "win32") {
      await dependencies.execute(
        "taskkill.exe",
        ["/PID", String(owner.pid), "/T", "/F"],
        {
          windowsHide: true,
          timeout: STOP_WAIT_MS,
          maxBuffer: 4096,
        },
      );
      return;
    }
    dependencies.signal(owner.pid, "SIGTERM");
  } catch {
    if (!(await dependencies.isAlive(owner.pid, owner.ownerIdentity))) return;
    throw replacementFailure("process could not be stopped");
  }
}

/** Retire only the lock's verified process incarnation; the new owner reclaims its own lock. */
export async function stopOwnedNativeCompanion(
  stateDir: string,
  overrides: Partial<NativeReplacementDependencies> = {},
): Promise<void> {
  const dependencies: NativeReplacementDependencies = {
    platform: process.platform,
    currentPid: process.pid,
    readLock: readLockSnapshot,
    readIdentity: readProcessOwnerIdentity,
    isAlive: isProcessOwnerAlive,
    signal: (pid, signal) => {
      process.kill(pid, signal);
    },
    execute: async (file, args, options) => {
      await executeFile(file, [...args], options);
    },
    now: Date.now,
    delay,
    ...overrides,
  };
  const lockPath = join(stateDir, "agent");
  const initial = await readReplacementLock(lockPath, dependencies);
  if (!initial) return;
  if (isReclaimableLockWithoutRecord(initial)) return;
  const owner = requireRecordedOwner(initial);
  if (!(await verifyLiveCompanionOwner(owner, dependencies))) return;
  const current = await readReplacementLock(lockPath, dependencies);
  if (!current) return;
  if (!isSameCompanionOwner(current, owner))
    throw replacementFailure("ownership changed during setup");
  if (!(await verifyLiveCompanionOwner(owner, dependencies))) return;
  await stopCompanionProcess(owner, dependencies);
  const deadline = dependencies.now() + STOP_WAIT_MS;
  while (await dependencies.isAlive(owner.pid, owner.ownerIdentity)) {
    if (dependencies.now() >= deadline)
      throw replacementFailure("process did not stop in time");
    await dependencies.delay(100);
  }
}
