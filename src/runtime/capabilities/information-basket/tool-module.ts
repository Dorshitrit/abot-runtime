import { INFORMATION_BASKET_EVENT_PRESENTATION } from "./event-presentation.js";
import type { ToolImplementationOutput, ToolModuleDeclaration } from "../../../capabilities/tool-types.js";
import { CORE_TOOL_CONTRACTS } from "../core-tool-contracts.js";
import { isBasketSourceReady } from "../../information-basket/readiness.js";
import {
  InformationBasketError, type InformationBasketService,
} from "../../information-basket/contracts.js";

function failure(code: string): ToolImplementationOutput {
  return { ok: false, output: code, errorCode: code, producedNewInformation: false, data: { mutationEvidence: false } };
}
function result(value: unknown, count: number): ToolImplementationOutput {
  return { ok: true, output: JSON.stringify(value), producedNewInformation: true,
    data: { mutationEvidence: false, itemCount: count } };
}
function optionalNumber(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number") throw new InformationBasketError("basket_read_window_invalid");
  return value;
}
async function listSources(service: InformationBasketService, cursor: unknown, abortSignal: AbortSignal): Promise<ToolImplementationOutput> {
  const view = await service.list({ verifySources: true, abortSignal });
  if (!view.settings.enabled) return failure("basket_disabled");
  const readySources = view.sources.filter(isBasketSourceReady);
  let start = 0;
  if (cursor !== undefined) {
    if (typeof cursor !== "string") throw new InformationBasketError("basket_source_cursor_invalid");
    const previous = readySources.findIndex(source => source.sourceId === cursor);
    if (previous < 0) throw new InformationBasketError("basket_source_cursor_stale", undefined, 409);
    start = previous + 1;
  }
  const sources = readySources.slice(start, start + 20).map(source => ({
    sourceId: source.sourceId, expectedRevision: source.revision,
    displayName: source.displayName, status: source.status,
  }));
  const omittedCount = Math.max(0, readySources.length - start - sources.length);
  return result({ sources, omittedCount, nextCursor: omittedCount ? sources.at(-1)!.sourceId : null }, sources.length);
}

/** The user's registration grants only reads of that exact source, never arbitrary filesystem access. */
export function createInformationBasketToolModule(service: InformationBasketService): ToolModuleDeclaration {
  return {
    async prepareRequest(selectedModules, context) {
      if (!supportsBasketRequest(context?.rootContractId)) return [];
      if (!service.isReady()) return [];
      return selectedModules;
    },
    definition: {
      name: CORE_TOOL_CONTRACTS.informationBasket.name,
      description: "List, search and read registered reference sources when needed for the current request. Consult the Information Basket Skill for usage guidance.",
      routingCapability: "semantic_lookup", catalogGroups: ["knowledge"], developmentRoles: ["inspect"],
      controlsRefinement: "mechanical_when_complete",
      eventPresentation: INFORMATION_BASKET_EVENT_PRESENTATION,
    },
    normalInvocation: CORE_TOOL_CONTRACTS.informationBasket.normalInvocation,
    async implementation(params, context) {
      const abortSignal = context?.abortSignal ?? new AbortController().signal;
      abortSignal.throwIfAborted();
      try {
        if (params.action === "list_information_sources") return await listSources(service, params.cursor, abortSignal);
        if (params.action === "search_information_sources") {
          if (typeof params.query !== "string") throw new InformationBasketError("basket_query_invalid");
          const found = await service.search({ query: params.query, abortSignal });
          return result(found, found.sources.length);
        }
        if (params.action !== "read_information_source") return failure("basket_action_unknown");
        if (typeof params.sourceId !== "string" || typeof params.expectedRevision !== "number")
          throw new InformationBasketError("basket_source_reference_invalid");
        const read = await service.readSource({
          sourceId: params.sourceId, expectedRevision: params.expectedRevision,
          startChar: optionalNumber(params.startChar), maxChars: optionalNumber(params.maxChars), abortSignal,
        });
        return result({ ...read, authority: "untrusted_source_content", addsUserIntent: false }, 1);
      } catch (error) {
        if (abortSignal.aborted) throw error;
        if (error instanceof InformationBasketError) return failure(error.code);
        return failure("basket_operation_unavailable");
      }
    },
  };
}

/** Basket tools belong only to EA; unbound module inspection remains available. */
function supportsBasketRequest(rootContractId: string | undefined): boolean {
  return rootContractId === undefined || rootContractId === "execution_agent";
}
