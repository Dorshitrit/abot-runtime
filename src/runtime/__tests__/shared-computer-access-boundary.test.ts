import { resolve, sep } from "node:path";
import { build } from "esbuild";
import { expect, test } from "vitest";

test("Runtime, Web, CLI and the computer SDK load without optional plugin files", async () => {
  const result = await build({
    entryPoints: [
      "src/runtime/runtime-environment.ts",
      "src/web-ui/server.ts",
      "src/cli/bin.ts",
      "src/plugin-sdk/computer-access.ts",
    ],
    outdir: ".codex/artifacts/shared-computer-access/boundary",
    bundle: true,
    packages: "external",
    platform: "node",
    format: "esm",
    write: false,
    metafile: true,
    plugins: [
      {
        name: "optional-plugins-absent",
        setup(builder) {
          builder.onResolve({ filter: /plugins[\\/]/ }, (args) => {
            const optional = resolve(args.resolveDir, args.path).startsWith(
              resolve("plugins") + sep,
            );
            if (optional)
              return {
                errors: [
                  {
                    text: `Host infrastructure must not load optional plugin: ${args.path}`,
                  },
                ],
              };
            return undefined;
          });
        },
      },
    ],
  });
  const inputs = Object.keys(result.metafile!.inputs);
  expect(inputs).toContain("src/computer-access/companion/native-session.ts");
  expect(inputs).toContain(
    "src/computer-access/companion/observation-client.ts",
  );
  expect(inputs.some((path) => path.startsWith("plugins/"))).toBe(false);
});
