/** Observe panel ancestors as well as browser visibility. */
export function createSystemHostVisibility({
  documentRoot,
  getRoot,
  isActive,
  onChange,
}) {
  const Observer = documentRoot?.defaultView?.MutationObserver;
  const observer = Observer ? new Observer(onChange) : null;
  function isVisible() {
    if (!isActive()) return false;
    if (documentRoot?.hidden) return false;
    return !getRoot()?.closest?.("[hidden]");
  }
  function watch() {
    observer?.disconnect();
    let element = getRoot();
    while (element) {
      observer?.observe(element, {
        attributes: true,
        attributeFilter: ["hidden"],
      });
      element = element.parentElement;
    }
  }
  documentRoot?.addEventListener("visibilitychange", onChange);
  return {
    isVisible,
    watch,
    dispose() {
      observer?.disconnect();
      documentRoot?.removeEventListener("visibilitychange", onChange);
    },
  };
}
