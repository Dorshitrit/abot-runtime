import { expect, test } from "vitest";
import { modelProfileLabels } from "../../web-ui/app/lib/model-profile-labels.js";

test("duplicate model names expose distinct saved profile identities without changing configuration", () => {
  const profiles = [
    { id: "qwen-ea", label: "Qwen", execution: { policy: "execution-agent-v1" } },
    { id: "qwen-super", label: "Qwen", execution: { policy: "supervisor-worker-v1" } },
    { id: "other", label: "My custom model" },
  ];
  const saved = structuredClone(profiles);
  expect([...modelProfileLabels(profiles)]).toEqual([
    ["qwen-ea", "Qwen · qwen-ea"],
    ["qwen-super", "Qwen · qwen-super"],
    ["other", "My custom model"],
  ]);
  expect(profiles).toEqual(saved);
});

test("unique labels remain unchanged and unlabeled profiles still have a usable choice", () => {
  expect([...modelProfileLabels([{ id: "local" }, { id: "cloud", label: " Work " }])])
    .toEqual([["local", "local"], ["cloud", "Work"]]);
  expect([...modelProfileLabels([{ id: "local" }, { id: "other", label: "local" }])])
    .toEqual([["local", "local · local"], ["other", "local · other"]]);
});
