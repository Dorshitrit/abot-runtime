import { expect, test } from "vitest";
import { modelSelectorFixture } from "./support/model-selector-fixture.js";

const models = [
  { value: "super", label: "Same model", dataset: {
    providerId: "ollama", providerLabel: "Ollama", executionPolicy: "supervisor-worker-v1",
  } },
  { value: "ea", label: "Same model", dataset: {
    providerId: "llamacpp", providerLabel: "llama.cpp", executionPolicy: "execution-agent-v1",
  } },
];

test("the selected model shows its catalog route inside the label with accessible next-request semantics", () => {
  const f = modelSelectorFixture(models);
  expect(f.valueLabel.querySelector(".model-select-route")?.textContent).toBe("Super");
  expect(f.button.getAttribute("aria-label")).toBe("Model: Ollama / Same model; Next request route: Supervisor");
  expect(f.button.title).toContain("Next request route: Supervisor");
  f.open();
  f.browse("llamacpp");
  expect(f.valueLabel.querySelector(".model-select-route")?.textContent).toBe("Super");
  f.choose("ea");
  expect(f.valueLabel.querySelector(".model-select-route")?.textContent).toBe("EA");
  expect(f.button.getAttribute("aria-label")).toBe("Model: llama.cpp / Same model; Next request route: Execution Agent");
  expect(f.select.value).toBe("ea");
  expect(f.changed).toHaveBeenCalledOnce();
  expect(f.documentRoot.activeElement).toBe(f.button);
});

test("native selection and catalog refresh replace the route without replacing the button arrow", () => {
  const f = modelSelectorFixture(models);
  const arrow = f.documentRoot.createElement("svg");
  arrow.setAttribute("viewBox", "0 0 20 20");
  f.button.append(arrow);
  f.select.value = "ea";
  f.select.dispatchEvent(new Event("change"));
  expect(f.valueLabel.querySelector(".model-select-route")?.textContent).toBe("EA");
  f.select.options[1].dataset!.executionPolicy = "supervisor-worker-v1";
  f.selector.sync();
  expect(f.valueLabel.querySelector(".model-select-route")?.textContent).toBe("Super");
  expect(f.valueLabel.querySelectorAll(".model-select-route")).toHaveLength(1);
  expect(f.button.children.at(-1)).toBe(arrow);
  expect(arrow.getAttribute("viewBox")).toBe("0 0 20 20");
  expect(f.changed).toHaveBeenCalledOnce();
});

test.each([undefined, "", "future-policy", "execution-agent-v1<script>"])(
  "missing or unsupported catalog policy %s does not infer a route from model identity",
  (executionPolicy) => {
    const f = modelSelectorFixture([{
      value: "execution-agent-v1", label: "EA", dataset: {
        ...(executionPolicy === undefined ? {} : { executionPolicy }),
      },
    }]);
    expect(f.valueLabel.querySelector(".model-select-route")).toBeNull();
    expect(f.button.title).toBe("Model: EA");
  },
);

test("losing catalog metadata clears the prior route and its accessible description", () => {
  const f = modelSelectorFixture(models, "ea");
  delete f.select.options[1].dataset!.executionPolicy;
  f.selector.sync();
  expect(f.valueLabel.querySelector(".model-select-route")).toBeNull();
  expect(f.button.title).toBe("Model: llama.cpp / Same model");
  expect(f.button.getAttribute("aria-label")).toBe(f.button.title);
});

test("an unavailable model selection does not claim an executable route", () => {
  const f = modelSelectorFixture(models, "ea", true);
  expect(f.valueLabel.querySelector(".model-select-route")).toBeNull();
  f.select.disabled = false;
  f.selector.sync();
  expect(f.valueLabel.querySelector(".model-select-route")?.textContent).toBe("EA");
});
