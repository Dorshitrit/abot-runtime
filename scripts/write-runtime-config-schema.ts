import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { format } from "prettier";

import { RUNTIME_CONFIG_JSON_SCHEMA } from "../src/runtime/config.js";

const outputPath = join(process.cwd(), "runtime.config.schema.json");
const content = await format(JSON.stringify(RUNTIME_CONFIG_JSON_SCHEMA), {
  parser: "json",
});

await writeFile(outputPath, content, "utf-8");
console.log(`wrote ${outputPath}`);
