import { parsePathOptions } from "./cli-args.js";
import { verifyPublicSnapshot } from "./snapshot.js";

async function main(): Promise<void> {
  const options = parsePathOptions({
    argv: process.argv.slice(2),
    allowed: ["--root"],
  });
  const outputRoot = options["--root"] ?? process.cwd();
  const record = await verifyPublicSnapshot({ outputRoot });
  process.stdout.write(
    `Public snapshot verified: ${record.files.length} files, tree ${record.treeSha256}\n`,
  );
}

await main().catch((error: unknown) => {
  process.stderr.write(
    `Public snapshot check failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
