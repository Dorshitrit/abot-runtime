/** Bounded review receipts only. Memory content is owned by the memory service. */
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
        reviewed: Array.isArray(value.reviewed) ? value.reviewed.filter((item) => typeof item?.id === "string" && typeof item.updatedAt === "string").slice(-200) : [],
      };
    } catch { /* A malformed projection does not count as a review receipt. */ }
    return volatile.get(environment) || {};
  }
  function save(environment, patch) {
    const value = { ...read(environment), ...patch };
    if (!storage) { volatile.set(environment, value); return; }
    return storage.setItem(key(environment), JSON.stringify(value));
  }
  return {
    dismissed: (environment) => read(environment).dismissed || [],
    dismiss(environment, id) {
      const dismissed = new Set(read(environment).dismissed || []);
      dismissed.add(id);
      return save(environment, { dismissed: [...dismissed].slice(-8) });
    },
    wasOffered: (environment, day) => read(environment).offeredOn === day,
    markOffered: (environment, day) => save(environment, { offeredOn: day }),
    hasReviewed(environment, record) {
      return (read(environment).reviewed || []).some((item) => item.id === record.id && item.updatedAt === record.updatedAt);
    },
    markReviewed(environment, record) {
      const reviewed = (read(environment).reviewed || []).filter((item) => item.id !== record.id);
      return save(environment, { reviewed: [...reviewed, { id: record.id, updatedAt: record.updatedAt }].slice(-200) });
    },
    forgetReviewed(environment, id) {
      const reviewed = (read(environment).reviewed || []).filter((item) => item.id !== id);
      return save(environment, { reviewed });
    },
  };
}

export function localReviewDay(date = new Date()) {
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}
