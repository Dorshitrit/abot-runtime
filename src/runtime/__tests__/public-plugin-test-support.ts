import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);

export function loadBundledPluginEntrypoint<TContext, TEntrypoint>(
  pluginName: string,
): (context: TContext) => TEntrypoint {
  const loaded = require(
    join(process.cwd(), "plugins", pluginName, "src", "index.cjs"),
  ) as { default?: unknown };
  const entrypoint = loaded.default ?? loaded;
  if (typeof entrypoint !== "function") {
    throw new TypeError(
      `Bundled plugin ${pluginName} did not export an entrypoint factory`,
    );
  }
  return entrypoint as (context: TContext) => TEntrypoint;
}
