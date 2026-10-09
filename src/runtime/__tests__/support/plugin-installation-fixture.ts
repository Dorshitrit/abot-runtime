import JSZip from "jszip";
import { AGENT_PLUGIN_MANIFEST_SCHEMA } from "../../../plugin-contract/manifest.js";
import type { PluginSourceFetcher } from "../../plugins/installation/github-download.js";

export const pluginSource = {
  repository: "https://github.com/community/example",
  ref: "a".repeat(40),
};
export function communityManifest(
  id = "community-example",
  capability = "community_ping",
) {
  return {
    $schema: AGENT_PLUGIN_MANIFEST_SCHEMA,
    name: id,
    version: "1.0.0",
    description: "A community fixture",
    extensions: {
      "ai.abot.runtime": {
        version: 1,
        entrypoint: "./src/index.cjs",
        capabilities: {
          [capability]: {
            description: "Ping",
            routingCapability: "semantic_lookup",
            skills: [],
            operations: {
              ping: {
                summary: "Return pong",
                input: {
                  type: "object",
                  additionalProperties: false,
                  properties: {},
                  required: [],
                },
                effect: "read_only",
                approval: "request_policy",
              },
            },
          },
        },
      },
    },
  };
}
export async function communityArchive(
  options: {
    manifest?: unknown;
    code?: string;
    subpath?: string;
    extra?: Record<string, string>;
  } = {},
): Promise<Buffer> {
  const zip = new JSZip();
  const path =
    "repository-commit/" + (options.subpath ? options.subpath + "/" : "");
  zip.file(
    path + "plugin.json",
    JSON.stringify(options.manifest ?? communityManifest()),
  );
  zip.file(
    path + "src/index.cjs",
    options.code ??
      'module.exports = () => ({ handlers: { community_ping: async () => ({ ok: true, output: "community pong", producedNewInformation: true }) } });',
  );
  for (const [name, value] of Object.entries(options.extra ?? {}))
    zip.file(name, value);
  return zip.generateAsync({ type: "nodebuffer" });
}
export function sourceFetcher(archive: Buffer): PluginSourceFetcher {
  return async (source) => ({
    source: { ...source, ref: pluginSource.ref },
    archive,
  });
}
