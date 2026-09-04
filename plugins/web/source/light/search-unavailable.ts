import { failureResult } from "../../../../src/plugin-sdk/index.js";
import { WebPluginError } from "../errors.js";
import {
  renderLightSearchMetadata,
  type LightSearchMetadata,
} from "./search-metadata.js";

export class LightSearchUnavailableError extends WebPluginError {
  constructor(readonly metadata: LightSearchMetadata) {
    super(
      "web_search_sources_unavailable",
      "None of the selected Light sources could be read.",
    );
  }
}

export function lightSearchFailureResult(error: unknown) {
  if (!(error instanceof LightSearchUnavailableError)) return undefined;
  return failureResult({
    errorCode: error.code,
    message: error.message,
    output: [
      `web_search failed: ${error.message}`,
      ...renderLightSearchMetadata(error.metadata),
    ].join("\n"),
    data: {
      hasData: false,
      itemCount: 0,
      eventMeta: { lightSearch: error.metadata },
      observationMeta: { kind: "volatile_external", carryPolicy: "never" },
    },
  });
}
