import { expect, test } from "vitest";
import type { RuntimeConfig } from "../ports.js";
import type { AutomationCatalogOperation } from "../automations/catalog.js";
import { createEmptyAutomationDefinition } from "../automations/draft-mutations.js";
import { fingerprintAutomationDependencies } from "../automations/dependency-fingerprint.js";

test("presentation copy does not invalidate a published operation, but attachment authority does", () => {
  const draft = createEmptyAutomationDefinition("automation", "Documents");
  const operation = { toolName: "reader", operationId: "read", contractVersion: 1 };
  const definition = {
    ...draft,
    body: { ...draft.body, children: [{
      kind: "tool" as const, id: "read_node", title: "Read", onFailure: "stop" as const,
      operation, controls: {},
    }] },
  };
  const catalog: AutomationCatalogOperation = {
    ...operation, label: "Read a document", catalogGroups: ["read"],
    toolDescription: "Long UI help text", permissionMode: "full_access",
    effect: "read_only", approval: "request_policy",
    input: { type: "object", additionalProperties: false, properties: {}, required: [] },
  };
  const digest = (entry: AutomationCatalogOperation) =>
    fingerprintAutomationDependencies({
      definition,
      config: {} as RuntimeConfig,
      operations: [entry],
    });
  expect(digest({ ...catalog, label: "New wording", toolDescription: "Short help", catalogGroups: ["web"] }))
    .toBe(digest(catalog));
  expect(digest({
    ...catalog,
    attachmentInput: { param: "source", acceptedMimeTypes: ["text/plain"] },
  })).not.toBe(digest(catalog));
});

test.each(["tool", "agent"] as const)("%s dependency identity includes fixed execution parameters", (kind) => {
  const draft = createEmptyAutomationDefinition("automation", "Pinned operation");
  const operation = { toolName: "publisher", operationId: "publish", contractVersion: 1 };
  const common = { id: "step", title: "Publish", onFailure: "stop" as const };
  const node = kind === "tool"
    ? { ...common, kind, operation, controls: {} }
    : { ...common, kind, modelProfileId: "model", agentMode: "fast" as const,
      roleInstructions: "Publish", prompt: "Publish", inputs: {},
      tools: [{ operation, usage: "available" as const }], result: { kind: "text" as const } };
  const definition = { ...draft, body: { ...draft.body, children: [node] } };
  const catalog: AutomationCatalogOperation = {
    ...operation, label: "Publish", catalogGroups: [], permissionMode: "full_access",
    effect: "mutating", approval: "request_policy",
    input: { type: "object", additionalProperties: false, properties: {}, required: [] },
  };
  const digest = (entry: AutomationCatalogOperation, extra: AutomationCatalogOperation[] = []) =>
    fingerprintAutomationDependencies({ definition, config: {} as RuntimeConfig, operations: [entry, ...extra] });
  const fixed = { ...catalog, fixedParams: { action: "publish", enabled: true, version: 1 } };
  expect(digest(fixed)).not.toBe(digest(catalog));
  expect(digest({ ...fixed, fixedParams: { action: "remove", enabled: true, version: 1 } }))
    .not.toBe(digest(fixed));
  expect(digest({ ...fixed, fixedParams: { action: "publish", enabled: false, version: 1 } }))
    .not.toBe(digest(fixed));
  expect(digest({ ...fixed, fixedParams: { version: 1, enabled: true, action: "publish" } }))
    .toBe(digest(fixed));
  expect(digest({ ...catalog, fixedParams: {} })).toBe(digest(catalog));
  expect(digest(fixed, [{ ...fixed, operationId: "unselected", fixedParams: { action: "anything" } }]))
    .toBe(digest(fixed));
});

test("colon-containing tool and operation IDs retain distinct dependency identities", () => {
  const draft = createEmptyAutomationDefinition("automation", "Distinct operations");
  const selected = { toolName: "a:b", operationId: "c", contractVersion: 1 };
  const colliding = { toolName: "a", operationId: "b:c", contractVersion: 1 };
  const definition = { ...draft, body: { ...draft.body, children: [{
    kind: "tool" as const, id: "selected", title: "Selected", onFailure: "stop" as const,
    operation: selected, controls: {},
  }] } };
  const catalog: AutomationCatalogOperation = { ...selected,
    label: "Selected", catalogGroups: [], permissionMode: "full_access",
    effect: "read_only", approval: "request_policy",
    input: { type: "object", additionalProperties: false, properties: {}, required: [] },
  };
  const digest = (operations: AutomationCatalogOperation[]) => fingerprintAutomationDependencies({
    definition, config: {} as RuntimeConfig, operations,
  });
  const other = { ...catalog, ...colliding };
  const before = digest([catalog, other]);
  expect(digest([{ ...catalog, fixedParams: { action: "changed" } }, other])).not.toBe(before);
  expect(digest([catalog, { ...other, fixedParams: { action: "unselected" } }])).toBe(before);
  expect(digest([other, catalog])).toBe(before);
});
