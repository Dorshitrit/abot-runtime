import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { ensurePrivateRuntimeDirectory } from "../../runtime/local-host/private-directory.js";
import { assertPrivateRuntimeAccess } from "../../runtime/local-host/private-access.js";
import { withFileLock } from "../../runtime/adapters/long-term-memory/file-lock.js";
import {
  CHATGPT_ISSUER,
  ChatGptAuthError,
  requireChatGptAccountRef,
  type ChatGptAccountStore,
  type StoredChatGptAccount,
} from "./contracts.js";

function validStoredAccount(value: StoredChatGptAccount): boolean {
  if (!value || typeof value !== "object") return false;
  try {
    requireChatGptAccountRef(value.accountRef);
  } catch {
    return false;
  }
  if (
    value.issuer !== CHATGPT_ISSUER ||
    typeof value.subject !== "string" ||
    !value.subject ||
    value.subject.length > 512
  )
    return false;
  if (
    typeof value.clientId !== "string" ||
    !/^[A-Za-z0-9_-]{1,200}$/u.test(value.clientId) ||
    value.clientId === "dynamic_agent_client"
  )
    return false;
  if (
    typeof value.label !== "string" ||
    value.label.length > 400 ||
    typeof value.planWelcomeAcknowledged !== "boolean"
  )
    return false;
  if (
    value.email !== undefined &&
    (typeof value.email !== "string" || value.email.length > 320)
  )
    return false;
  if (
    value.authorizationRevision !== undefined &&
    (!Number.isSafeInteger(value.authorizationRevision) ||
      value.authorizationRevision < 0)
  )
    return false;
  if (!value.tokens) return true;
  const tokens = value.tokens;
  if (
    typeof tokens.accessToken !== "string" ||
    tokens.accessToken.length > 32768
  )
    return false;
  if (typeof tokens.idToken !== "string" || tokens.idToken.length > 32768)
    return false;
  if (
    tokens.refreshToken !== undefined &&
    (typeof tokens.refreshToken !== "string" ||
      tokens.refreshToken.length > 32768)
  )
    return false;
  if (!Number.isFinite(tokens.expiresAt)) return false;
  return (
    Array.isArray(tokens.scopes) &&
    tokens.scopes.length <= 30 &&
    tokens.scopes.every(
      (scope) => typeof scope === "string" && scope.length < 200,
    )
  );
}
function parseStore(text: string): ChatGptAccountStore {
  const value = JSON.parse(text) as ChatGptAccountStore;
  if (
    value?.version !== 1 ||
    typeof value.hostId !== "string" ||
    !value.hostId.startsWith("urn:uuid:")
  )
    throw new Error("invalid_store");
  requireChatGptAccountRef(value.hostId.slice(9));
  if (
    !Array.isArray(value.accounts) ||
    value.accounts.length > 50 ||
    !value.accounts.every(validStoredAccount)
  )
    throw new Error("invalid_accounts");
  if (
    new Set(value.accounts.map((account) => account.accountRef)).size !==
    value.accounts.length
  )
    throw new Error("duplicate_accounts");
  return value;
}
export class ChatGptStore {
  readonly directory: string;
  constructor(
    directory = join(homedir(), ".abot", "provider-auth", "chatgpt"),
  ) {
    this.directory = directory;
  }
  private async readExisting(): Promise<ChatGptAccountStore | undefined> {
    const path = join(this.directory, "accounts.json");
    let info;
    try {
      info = await lstat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    if (!info.isFile() || info.isSymbolicLink() || info.size > 2 * 1024 * 1024)
      throw new Error("unsafe_account_store");
    await assertPrivateRuntimeAccess(path, info, "chatgpt_store_not_private");
    const file = await open(
      path,
      constants.O_RDONLY |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_NONBLOCK ?? 0),
    );
    try {
      const actual = await file.stat();
      if (
        !actual.isFile() ||
        actual.dev !== info.dev ||
        actual.ino !== info.ino ||
        actual.size !== info.size
      )
        throw new Error("changed_account_store");
      const bytes = Buffer.alloc(2 * 1024 * 1024 + 1);
      let length = 0;
      while (length < bytes.length) {
        const result = await file.read(
          bytes,
          length,
          bytes.length - length,
          null,
        );
        if (result.bytesRead === 0) break;
        length += result.bytesRead;
      }
      if (length > 2 * 1024 * 1024) throw new Error("account_store_full");
      return parseStore(bytes.subarray(0, length).toString("utf8"));
    } finally {
      await file.close();
    }
  }
  private async write(value: ChatGptAccountStore): Promise<void> {
    const text = JSON.stringify(value);
    parseStore(text);
    if (Buffer.byteLength(text) > 2 * 1024 * 1024)
      throw new Error("account_store_full");
    const path = join(this.directory, "accounts.json");
    const temporary = join(this.directory, randomUUID() + ".tmp");
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(text);
      await file.sync();
      await file.close();
      await assertPrivateRuntimeAccess(
        temporary,
        await lstat(temporary),
        "chatgpt_store_not_private",
      );
      await rename(temporary, path);
    } finally {
      await file.close().catch(() => undefined);
      await rm(temporary, { force: true });
    }
  }
  async read(): Promise<ChatGptAccountStore> {
    return this.transaction(async (value) => structuredClone(value));
  }
  async transaction<T>(
    operation: (value: ChatGptAccountStore) => Promise<T>,
  ): Promise<T> {
    try {
      await ensurePrivateRuntimeDirectory(this.directory);
      return await withFileLock(
        join(this.directory, "accounts.lock"),
        async () => {
          const existing = await this.readExisting();
          const value = existing ?? {
            version: 1 as const,
            hostId: "urn:uuid:" + randomUUID(),
            accounts: [],
          };
          const before = existing ? JSON.stringify(existing) : undefined;
          const result = await operation(value);
          if (before !== JSON.stringify(value)) await this.write(value);
          return result;
        },
        { waitMs: 20000 },
      );
    } catch (error) {
      if (error instanceof ChatGptAuthError) throw error;
      throw new ChatGptAuthError(
        "chatgpt_store_unavailable",
        "The private ChatGPT account store is unavailable.",
        503,
      );
    }
  }
}
export function storedAccount(
  store: ChatGptAccountStore,
  accountRef: string,
): StoredChatGptAccount {
  requireChatGptAccountRef(accountRef);
  const account = store.accounts.find(
    (entry) => entry.accountRef === accountRef,
  );
  if (!account)
    throw new ChatGptAuthError(
      "chatgpt_account_not_found",
      "This ChatGPT account is not saved.",
      404,
    );
  return account;
}

export function accountAuthorizationRevision(
  account: StoredChatGptAccount,
): number {
  return account.authorizationRevision ?? 0;
}
export function requireAccountAuthorizationRevision(
  account: StoredChatGptAccount,
  expected: number,
): void {
  if (accountAuthorizationRevision(account) !== expected)
    throw new ChatGptAuthError(
      "chatgpt_attempt_cancelled",
      "This sign-in was cancelled by another account action.",
      409,
    );
}
