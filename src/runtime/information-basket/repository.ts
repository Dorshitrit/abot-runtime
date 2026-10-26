import { randomUUID } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { withFileLock } from "../adapters/long-term-memory/file-lock.js";
import { InformationBasketError } from "./contracts.js";
import { emptyBasketSnapshot, type BasketRepository, type BasketSnapshot } from "./index-records.js";
import { BASKET_LIMITS } from "./limits.js";
import { parseBasketSnapshot } from "./snapshot-validation.js";

export function createBasketRepository(directory: string, hostNamespace: string): BasketRepository {
  const file = join(directory, "basket.json");
  async function read(): Promise<BasketSnapshot> {
    let handle;
    try {
      handle = await open(file, "r");
      const size = (await handle.stat()).size;
      if (size > BASKET_LIMITS.maxStoreBytes) throw new InformationBasketError("basket_storage_too_large", undefined, 503);
      const bytes = await handle.readFile();
      if (bytes.length > BASKET_LIMITS.maxStoreBytes) throw new InformationBasketError("basket_storage_too_large", undefined, 503);
      return parseBasketSnapshot(JSON.parse(bytes.toString("utf8")), hostNamespace);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyBasketSnapshot(hostNamespace);
      if (error instanceof InformationBasketError) throw error;
      throw new InformationBasketError("basket_storage_unavailable", undefined, 503);
    } finally { await handle?.close(); }
  }
  async function write(snapshot: BasketSnapshot): Promise<void> {
    const content = JSON.stringify(snapshot);
    if (Buffer.byteLength(content) > BASKET_LIMITS.maxStoreBytes)
      throw new InformationBasketError("basket_storage_too_large", undefined, 503);
    const temporary = file + "." + randomUUID() + ".tmp";
    try {
      const handle = await open(temporary, "wx", 0o600);
      try { await handle.writeFile(content, "utf8"); await handle.sync(); }
      finally { await handle.close(); }
      await rename(temporary, file);
    } finally { await rm(temporary, { force: true }); }
  }
  return Object.freeze({
    read,
    async update(change) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      return withFileLock(join(directory, "basket.lock"), async () => {
        const current = await read();
        const next = change(current);
        if (next === current) return current;
        await write(next);
        return next;
      });
    },
  });
}
