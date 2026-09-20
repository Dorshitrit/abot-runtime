import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { join } from "node:path";
import {
  isHostIdentifier,
  isHostIdentity,
  isHostRecord,
  type HostIdentity,
} from "./protocol.js";
import {
  hostStateDirectory,
  readHostPrivateJson,
  writeHostPrivateJson,
} from "./private-store.js";

type PairingRecord = {
  version: 1;
  pending?: { digest: string; expiresAt: number };
  host?: { hostId: string; identity: HostIdentity; credentialDigest: string };
};
function tokenDigest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
function matchesToken(token: string, digest: string): boolean {
  if (!/^[a-f0-9]{64}$/u.test(digest)) return false;
  return timingSafeEqual(
    Buffer.from(tokenDigest(token), "hex"),
    Buffer.from(digest, "hex"),
  );
}
function isBoundedPairingLifetime(lifetimeMs: number): boolean {
  if (!Number.isSafeInteger(lifetimeMs)) return false;
  if (lifetimeMs < 1) return false;
  return lifetimeMs <= 15 * 60_000;
}
function isStoredPairing(value: unknown): value is PairingRecord {
  if (!isHostRecord(value)) return false;
  if (value.version !== 1) return false;
  if (value.pending !== undefined) {
    if (!isHostRecord(value.pending)) return false;
    if (typeof value.pending.digest !== "string") return false;
    if (typeof value.pending.expiresAt !== "number") return false;
  }
  if (value.host === undefined) return true;
  if (!isHostRecord(value.host)) return false;
  if (!isHostIdentifier(value.host.hostId)) return false;
  if (!isHostIdentity(value.host.identity)) return false;
  return typeof value.host.credentialDigest === "string";
}
export class HostPairingStore {
  private readonly path: string;
  constructor(
    rootDir: string,
    private readonly now = Date.now,
  ) {
    this.path = join(hostStateDirectory(rootDir), "pairing.json");
  }
  private read(): PairingRecord {
    const value = readHostPrivateJson(this.path);
    if (value === undefined) return { version: 1 };
    if (!isStoredPairing(value)) throw new Error("host_pairing_state_invalid");
    return value;
  }
  host() {
    return this.read().host;
  }
  begin(lifetimeMs = 5 * 60_000): { code: string; expiresAt: string } {
    if (!isBoundedPairingLifetime(lifetimeMs))
      throw new Error("host_pairing_lifetime_invalid");
    if (this.host()) throw new Error("host_already_paired");
    const code = randomBytes(32).toString("base64url");
    const expiresAt = this.now() + lifetimeMs;
    writeHostPrivateJson(this.path, {
      version: 1,
      pending: { digest: tokenDigest(code), expiresAt },
    });
    return { code, expiresAt: new Date(expiresAt).toISOString() };
  }
  authenticate(token: string): "pairing" | "credential" | undefined {
    if (!/^[A-Za-z0-9_-]{43}$/u.test(token)) return undefined;
    const record = this.read();
    if (record.host && matchesToken(token, record.host.credentialDigest))
      return "credential";
    if (!record.pending) return undefined;
    if (record.pending.expiresAt <= this.now()) return undefined;
    if (matchesToken(token, record.pending.digest)) return "pairing";
    return undefined;
  }
  consume(
    code: string,
    identity: HostIdentity,
  ): { hostId: string; credential: string } {
    if (this.authenticate(code) !== "pairing")
      throw new Error("host_pairing_expired");
    const hostId = randomUUID();
    const credential = randomBytes(32).toString("base64url");
    writeHostPrivateJson(this.path, {
      version: 1,
      host: { hostId, identity, credentialDigest: tokenDigest(credential) },
    });
    return { hostId, credential };
  }
  revoke(): void {
    writeHostPrivateJson(this.path, { version: 1 });
  }
}
