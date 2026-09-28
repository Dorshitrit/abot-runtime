function calibrationExpansionTarget(state, details) {
  const sectionKey = details?.dataset?.calibrationSectionKey;
  if (sectionKey)
    return { key: sectionKey, expanded: state.expandedCalibrationSections };
  const profileKey = details?.dataset?.calibrationKey;
  if (profileKey)
    return { key: profileKey, expanded: state.expandedCalibrationKeys };
  return null;
}

export function rememberCalibrationDisclosure(state, details) {
  const target = calibrationExpansionTarget(state, details);
  if (!target) return;
  if (details.open) {
    target.expanded.add(target.key);
    return;
  }
  target.expanded.delete(target.key);
}

export function createConfigCalibrationDisclosure({ state, root }) {
  let active = false;

  function setActive(nextActive) {
    const enteringConfig = nextActive && !active;
    active = nextActive;
    if (!enteringConfig) return;

    state.expandedCalibrationKeys.clear();
    state.expandedCalibrationSections.clear();
    for (const details of root.querySelectorAll(
      "details[data-calibration-key], details[data-calibration-section-key]",
    )) {
      details.open = false;
    }
  }

  return { setActive };
}
