type CachedPreview<Value> = {
  value: Value;
  expiresAt: number;
};

export function createPreviewCache<Value>(maxEntries: number, now = Date.now) {
  const entries = new Map<string, CachedPreview<Value>>();
  const discardExpired = () => {
    for (const [key, entry] of entries) {
      if (entry.expiresAt <= now()) entries.delete(key);
    }
  };
  return Object.freeze({
    get(key: string): Value | undefined {
      discardExpired();
      return entries.get(key)?.value;
    },
    set(key: string, value: Value, ttlMs: number): void {
      discardExpired();
      entries.delete(key);
      entries.set(key, { value, expiresAt: now() + ttlMs });
      while (entries.size > maxEntries) {
        entries.delete(entries.keys().next().value!);
      }
    },
  });
}
