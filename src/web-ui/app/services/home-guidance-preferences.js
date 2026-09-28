/** Browser-local review receipts only. Memory content never goes into storage. */
export function createHomeGuidancePreferences(storage) {
  const key = (environment) => `abot-web.homeGuidance.${encodeURIComponent(environment)}`;
  const volatile = new Map();
  function read(environment) {
    if (volatile.has(environment)) return volatile.get(environment);
    try {
      const value = JSON.parse(storage?.getItem(key(environment)) || "null");
      if (value && typeof value === "object" && !Array.isArray(value)) return {
        offeredOn: typeof value.offeredOn === "string" ? value.offeredOn : "",
        dismissed: Array.isArray(value.dismissed) ? value.dismissed.filter((id) => typeof id === "string").slice(-8) : [],
        reviewed: Array.isArray(value.reviewed) ? value.reviewed.filter((id) => typeof id === "string").slice(-200) : [],
      };
    } catch { /* Browser preferences may be unavailable. */ }
    return volatile.get(environment) || {};
  }
  function save(environment, patch) {
    const value = { ...read(environment), ...patch };
    try {
      if (!storage) throw new Error("Storage unavailable");
      storage.setItem(key(environment), JSON.stringify(value));
      volatile.delete(environment);
    } catch { volatile.set(environment, value); }
  }
  return {
    dismissed: (environment) => read(environment).dismissed || [],
    dismiss(environment, id) {
      const dismissed = new Set(read(environment).dismissed || []);
      dismissed.add(id);
      save(environment, { dismissed: [...dismissed].slice(-8) });
    },
    wasOffered: (environment, day) => read(environment).offeredOn === day,
    markOffered: (environment, day) => save(environment, { offeredOn: day }),
    hasReviewed(environment, record) {
      return (read(environment).reviewed || []).includes(`${record.id}:${record.updatedAt}`);
    },
    markReviewed(environment, record) {
      const receipt = `${record.id}:${record.updatedAt}`;
      const reviewed = (read(environment).reviewed || []).filter((id) => id !== receipt);
      save(environment, { reviewed: [...reviewed, receipt].slice(-200) });
    },
  };
}

export function localReviewDay(date = new Date()) {
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}
