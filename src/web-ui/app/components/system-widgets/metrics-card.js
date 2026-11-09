import { metricPercent, metricsStatusLabel, metricsScopePresentation, metricsCpuDetail,
  metricsMemoryDetail, metricsMemoryBasis, metricsMemoryLabel } from "./metrics-presentation.js";

export const SYSTEM_METRICS_HEIGHT = 280;

function setText(node, value) {
  if (node.textContent !== value) node.textContent = value;
}
function setAttribute(node, key, value) {
  if (node.getAttribute(key) !== value) node.setAttribute(key, value);
}

/** Build once. Updates touch only leaf text, accessibility values and two bounded bar transforms. */
export function createSystemMetricsCard(root, documentRoot = root.ownerDocument) {
  function element(tag, className, text = "") {
    const node = documentRoot.createElement(tag); node.className = className; node.textContent = text; return node;
  }
  const card = element("section", "system-widget-card system-metrics-card");
  card.setAttribute("aria-label", "System monitor");
  const header = element("header", "system-metrics-header");
  const heading = element("div", "system-metrics-heading");
  heading.append(element("span", "system-widget-origin", "SYSTEM"), element("h3", "", "System monitor"));
  const scope = element("span", "system-metrics-scope", "…");
  header.append(heading, scope);
  const body = element("div", "system-metrics-body");
  function meter(label) {
    const row = element("div", "system-metrics-row");
    const line = element("div", "system-metrics-line");
    const value = element("strong", "system-metrics-value", "—");
    const caption = element("span", "", label); line.append(caption, value);
    const track = element("div", "system-metrics-track");
    track.setAttribute("role", "meter"); track.setAttribute("aria-label", label);
    track.setAttribute("aria-valuemin", "0"); track.setAttribute("aria-valuemax", "100");
    const fill = element("div", "system-metrics-fill"); track.append(fill);
    const detail = element("span", "system-metrics-detail", "Waiting for a sample");
    row.append(line, track, detail); body.append(row);
    return { value, track, fill, detail, caption };
  }
  const cpu = meter("CPU used"); const memory = meter("Memory used");
  const thermal = element("div", "system-metrics-temperature");
  const temperatureLabel = element("span", "", "Temperature");
  const temperature = element("strong", "system-metrics-value", "—");
  thermal.append(temperatureLabel, temperature); body.append(thermal);
  const footer = element("footer", "system-metrics-footer");
  const status = element("span", "system-metrics-status", "Connecting…");
  const cadence = element("span", "system-metrics-cadence", "Every 2s");
  footer.append(status, cadence); card.append(header, body, footer); root.append(card);

  function updateMeter(nodes, percent, detail) {
    const available = Number.isFinite(percent);
    const bounded = available ? Math.min(100, Math.max(0, percent)) : 0;
    setText(nodes.value, metricPercent(percent)); setText(nodes.detail, detail);
    setAttribute(nodes.track, "aria-valuetext", available ? metricPercent(percent) : "Not available");
    if (available) setAttribute(nodes.track, "aria-valuenow", String(Math.round(bounded)));
    if (!available && nodes.track.getAttribute("aria-valuenow") !== null) nodes.track.removeAttribute("aria-valuenow");
    const transform = `scaleX(${(bounded / 100).toFixed(3)})`;
    if (nodes.fill.style.getPropertyValue("transform") !== transform) nodes.fill.style.setProperty("transform", transform);
  }
  return {
    render(state) {
      const metrics = state.metrics;
      setText(status, metricsStatusLabel(state.status));
      setAttribute(card, "data-metrics-status", state.status);
      if (!metrics) {
        updateMeter(cpu, null, "Waiting for a sample"); updateMeter(memory, null, "Waiting for a sample");
        setText(temperature, "—"); setText(scope, "…");
        setAttribute(scope, "title", "Waiting for measurement scope."); setAttribute(status, "title", "No current sample.");
        setAttribute(temperature, "title", "Temperature is not available.");
        return;
      }
      const origin = metricsScopePresentation(metrics.scope);
      setText(scope, origin.label); setAttribute(scope, "title", origin.detail);
      updateMeter(cpu, metrics.cpu.percent, metricsCpuDetail(metrics.cpu, origin.label));
      updateMeter(memory, metrics.memory.percent, metricsMemoryDetail(metrics.memory));
      const memoryLabel = metricsMemoryLabel(metrics.memory, metrics.scope);
      setText(memory.caption, memoryLabel); setAttribute(memory.track, "aria-label", memoryLabel);
      setAttribute(memory.track, "title", metricsMemoryBasis(metrics.memory.basis));
      const degrees = metrics.temperature.celsius;
      const hostSensorOutsideScope = metrics.temperature.scope === "computer" && metrics.scope.kind !== "computer";
      setText(temperatureLabel, hostSensorOutsideScope ? "Host temperature" : "Temperature");
      setText(temperature, Number.isFinite(degrees) ? `${degrees.toFixed(1)} °C` : "Not available");
      setAttribute(temperature, "title", degrees === null ? "No supported temperature sensor is exposed to ABot."
        : `${metrics.temperature.sensor} · Physical computer sensor, refreshed at most every 30s.`);
      setAttribute(status, "title", `Sampled ${metrics.sampledAt}`);
    },
    dispose() { card.remove(); },
  };
}
