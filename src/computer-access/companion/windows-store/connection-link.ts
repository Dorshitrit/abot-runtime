import { isNativeLoopbackAddress, normalizeNativeRuntimeUrl } from "../native-address.js";
import { isHostIdentifier, isHostRecord } from "../protocol.js";
import { COMPANION_RELEASE_VERSION } from "../release-version.js";
import { WINDOWS_COMPANION_STORE } from "./identity.js";

export const STORE_CONNECTION_LINK_MAX_BYTES = 8_192;

export type StoreConnectionInvitation = Readonly<{
  version: 1;
  url: string;
  code: string;
  expiresAt: string;
  companionRelease: number;
  upgradeHostId?: string;
}>;

function invalidInvitation(): Error {
  // Incoming links contain a secret. Never include their text in an error.
  return new Error("Invalid Companion connection invitation. Open Computer access in ABot and request a new connection.");
}

function isLoopbackInvitationOrigin(url: URL): boolean {
  if (url.protocol !== "http:") return false;
  if (url.hostname === "localhost") return true;
  if (url.hostname.endsWith(".localhost")) return true;
  return isNativeLoopbackAddress(url.hostname);
}

export function readStoreConnectionInvitation(
  value: unknown,
  now = Date.now(),
): StoreConnectionInvitation {
  if (!isHostRecord(value)) throw invalidInvitation();
  const fields = ["version", "url", "code", "expiresAt", "companionRelease", "upgradeHostId"];
  if (Object.keys(value).some((key) => !fields.includes(key))) throw invalidInvitation();
  if (value.version !== 1) throw invalidInvitation();
  const origin = normalizeStoreConnectionOrigin(value.url);
  if (typeof value.code !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(value.code)) throw invalidInvitation();
  if (typeof value.expiresAt !== "string") throw invalidInvitation();
  const expiresAt = Date.parse(value.expiresAt);
  if (!Number.isFinite(expiresAt)) throw invalidInvitation();
  if (expiresAt <= now) throw new Error("This connection invitation has expired. Click Connect in ABot again.");
  if (!Number.isSafeInteger(value.companionRelease)) throw invalidInvitation();
  if (Number(value.companionRelease) < 1) throw invalidInvitation();
  if (Number(value.companionRelease) > COMPANION_RELEASE_VERSION)
    throw new Error("Update ABot AI Companion in Microsoft Store, then connect again.");
  if (value.upgradeHostId !== undefined && !isHostIdentifier(value.upgradeHostId)) throw invalidInvitation();
  return {
    version: 1,
    url: origin,
    code: value.code,
    expiresAt: new Date(expiresAt).toISOString(),
    companionRelease: Number(value.companionRelease),
    ...(value.upgradeHostId === undefined ? {} : { upgradeHostId: value.upgradeHostId }),
  };
}

export function normalizeStoreConnectionOrigin(value: unknown): string {
  if (typeof value !== "string" || value.length > 4_096) throw invalidInvitation();
  let url: URL;
  try {
    url = new URL(value);
    normalizeNativeRuntimeUrl(value);
  } catch {
    throw invalidInvitation();
  }
  if (!isLoopbackInvitationOrigin(url)) throw invalidInvitation();
  if (/[\x00-\x20\x7f]/u.test(value)) throw invalidInvitation();
  return url.origin;
}

export function createStoreConnectionLink(invitation: StoreConnectionInvitation): string {
  const data = readStoreConnectionInvitation(invitation);
  const link = new URL(`${WINDOWS_COMPANION_STORE.protocol}//connect`);
  link.searchParams.set("invitation", Buffer.from(JSON.stringify(data)).toString("base64url"));
  if (Buffer.byteLength(link.href) > STORE_CONNECTION_LINK_MAX_BYTES) throw invalidInvitation();
  return link.href;
}

export function parseStoreConnectionLink(link: string, now = Date.now()): StoreConnectionInvitation {
  if (Buffer.byteLength(link) > STORE_CONNECTION_LINK_MAX_BYTES) throw invalidInvitation();
  let url: URL;
  try { url = new URL(link); } catch { throw invalidInvitation(); }
  if (url.protocol !== WINDOWS_COMPANION_STORE.protocol) throw invalidInvitation();
  if (url.hostname !== "connect" || url.port || url.username || url.password || url.hash) throw invalidInvitation();
  if (url.pathname !== "" && url.pathname !== "/") throw invalidInvitation();
  const entries = [...url.searchParams];
  if (entries.length !== 1 || entries[0][0] !== "invitation") throw invalidInvitation();
  const encoded = entries[0][1];
  if (!/^[A-Za-z0-9_-]+$/u.test(encoded)) throw invalidInvitation();
  let data: unknown;
  try { data = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")); }
  catch { throw invalidInvitation(); }
  return readStoreConnectionInvitation(data, now);
}
