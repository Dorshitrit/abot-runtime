#!/usr/bin/env node

import { runAbotCli } from "./abot.js";

runAbotCli().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
