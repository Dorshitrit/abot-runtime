import { automationRunPage } from "./automation-run-history.js";

export function validationResult(value) {
  if (Array.isArray(value)) return { issues: value };
  if (Array.isArray(value?.issues)) return value;
  return null;
}

export async function readAutomationList(client, environmentId) {
  const [listed, catalog] = await Promise.allSettled([
    client.listAutomations(environmentId), client.getAutomationCatalog("", environmentId),
  ]);
  if (listed.status === "rejected") throw listed.reason;
  return {
    automations: Array.isArray(listed.value.automations) ? listed.value.automations : [],
    templateCatalog: catalog.status === "fulfilled" ? catalog.value : null,
    templateCatalogError: catalog.status === "rejected"
      ? "Templates are unavailable right now. Refresh to try again." : "",
  };
}

export async function readAutomationSelection(client, automationId, runId, environmentId,
  { runsQuery = { limit: 50 } } = {}) {
  const [draftResponse, catalog, runsResponse, runResponse] = await Promise.all([
    client.getAutomationDraft(automationId, environmentId),
    client.getAutomationCatalog(automationId, environmentId),
    runsQuery ? client.listAutomationRuns(automationId, environmentId, runsQuery) : Promise.resolve(null),
    runId ? client.getAutomationRun(runId, environmentId) : Promise.resolve(null),
  ]);
  if (runResponse?.run && runResponse.run.automationId !== automationId)
    throw new Error("This run belongs to another automation.");
  return {
    draft: draftResponse.draft || null,
    publishedDefinition: draftResponse.publishedDefinition || null,
    grant: draftResponse.grant || null,
    validation: validationResult(draftResponse.validation),
    catalog,
    ...(runsResponse ? automationRunPage(runsResponse) : {}),
    run: runResponse?.run || null,
  };
}

export async function readAutomationBackgroundProjection(client, identity) {
  const [list, selected, evidenceResponse] = await Promise.all([
    readAutomationList(client, identity.environmentId),
    identity.automationId
      ? readAutomationSelection(client, identity.automationId, identity.runId, identity.environmentId,
        { runsQuery: identity.runsQuery })
      : Promise.resolve(null),
    identity.runId && identity.nodeId
      ? client.getAutomationStepEvidence(identity.runId, identity.nodeId,
        identity.environmentId, identity.full)
      : Promise.resolve(null),
  ]);
  const projection = { ...list, ...(selected || {}) };
  const evidence = evidenceResponse?.evidence;
  if (evidence?.runId === identity.runId && evidence.nodeId === identity.nodeId) {
    projection.stepEvidence = evidence;
    projection.stepEvidenceError = "";
  }
  return projection;
}

export function automationProjectionChanged(state, projection) {
  return Object.entries(projection).some(([key, value]) =>
    JSON.stringify(state[key]) !== JSON.stringify(value));
}
