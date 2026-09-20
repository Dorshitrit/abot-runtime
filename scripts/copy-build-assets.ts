import { copyFile, cp, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { buildHostCompanionBundle } from "./build-host-companion.js";

const buildAssets = [
  {
    source: "src/shared/model-step-registry-data.json",
    target: "dist/src/shared/model-step-registry-data.json",
    recursive: false,
  },
  {
    source: "src/web-ui/app",
    target: "dist/src/web-ui/app",
    recursive: true,
  },
];

for (const asset of buildAssets) {
  const targetPath = join(process.cwd(), asset.target);
  await mkdir(dirname(targetPath), { recursive: true });
  if (asset.recursive) {
    await cp(join(process.cwd(), asset.source), targetPath, {
      recursive: true,
    });
  } else {
    await copyFile(join(process.cwd(), asset.source), targetPath);
  }
}

console.log(`copied ${buildAssets.length} build asset(s)`);
const companion = await buildHostCompanionBundle();
console.log(`built standalone host companion (${companion.bytes} bytes)`);
