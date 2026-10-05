import { updateLiveRegion } from "../../lib/live-region.js";

function ancestorScrollPositions(root) {
  const positions = [];
  for (let node = root.parentElement; node; node = node.parentElement)
    positions.push({ node, top: node.scrollTop, left: node.scrollLeft });
  return positions;
}

/** Keep view state only within the same automation/run, never across navigation. */
export function createAutomationLiveView(root) {
  let renderedIdentity;

  function clear() {
    updateLiveRegion(root, "");
    root.scrollTop = 0;
    root.scrollLeft = 0;
    renderedIdentity = undefined;
  }

  return {
    isCurrent: (identity) => renderedIdentity === identity,
    clear,
    update(identity, markup) {
      const sameIdentity = renderedIdentity === identity;
      const scroll = sameIdentity ? ancestorScrollPositions(root) : [];
      if (!sameIdentity) clear();
      renderedIdentity = identity;
      const changed = updateLiveRegion(root, markup);
      // The scrolling workspace is outside this region. Replacing its content
      // can temporarily clamp that ancestor to zero before the new DOM is ready.
      for (const { node, top, left } of scroll) {
        node.scrollTop = top;
        node.scrollLeft = left;
      }
      return changed;
    },
  };
}
