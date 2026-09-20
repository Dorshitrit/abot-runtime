import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { createDefaultToolRegistry } from "../default-adapters.js";
import { loadPublicRuntimeConfig } from "./public-runtime-config-fixture.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

test("cached plugin entrypoint prepares the selected catalog once per request without retaining its binding", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "request-plugin-"));
  roots.push(rootDir);
  const pluginRoot = join(rootDir, "plugins", "request-fixture");
  await mkdir(join(pluginRoot, "src"), { recursive: true });
  const capabilities = Object.fromEntries(
    ["first", "second", "disabled"].map((name) => [
      name,
      {
        description: "Bound fixture operation.",
        routingCapability: "semantic_lookup",
        skills: [],
        operations: {
          [name]: {
            summary: "Use an available fixture destination.",
            effect: "read_only",
            approval: "request_policy",
            input: {
              type: "object",
              additionalProperties: false,
              required: ["destination"],
              properties: {
                destination: { type: "string", enum: ["one", "two"] },
              },
            },
          },
        },
      },
    ]),
  );
  await writeFile(
    join(pluginRoot, "plugin.json"),
    JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name: "request-fixture",
      version: "1.0.0",
      extensions: {
        "ai.abot.runtime": {
          version: 1,
          entrypoint: "./src/index.cjs",
          capabilities,
        },
      },
    }),
  );
  await writeFile(
    join(pluginRoot, "src", "index.cjs"),
    `module.exports = () => {
    let observations = 0;
    const base = async () => ({ ok: false, output: 'unprepared', producedNewInformation: false });
    return {
      handlers: { first: base, second: base, disabled: base },
      prepareRequest: async modules => {
        const capture = ++observations;
        if (modules.length !== 2) throw new Error('selected scope widened');
        const destination = capture === 1 ? 'one' : 'two';
        return modules.map(module => ({
          ...module,
          implementation: async () => ({ ok: true, output: String(capture), producedNewInformation: true }),
          adapter: { executionBinding: () => ({ identity: 'private-' + capture }) },
          normalInvocation: {
            ...module.normalInvocation,
            operations: module.normalInvocation.operations.map(operation => ({
              ...operation, input: { ...operation.input, properties: {
                destination: { type: 'string', enum: [destination] }
              } }
            }))
          }
        }));
      }
    };
  };`,
  );
  const template = loadPublicRuntimeConfig([]);
  const config = {
    ...template,
    paths: { ...template.paths, rootDir },
    plugins: { allow: ["request-fixture"], deny: ["request-fixture.disabled"] },
  };
  const registry = createDefaultToolRegistry(config);
  const first = await registry.prepareRequest!();
  const second = await registry.prepareRequest!();
  expect(first.listDefinitions().map(({ name }) => name)).toEqual([
    "first",
    "second",
  ]);
  expect(second.listDefinitions().map(({ name }) => name)).toEqual([
    "first",
    "second",
  ]);
  expect(
    first.getAdapter!("first")!.executionBinding!({
      tool: "first",
      params: {},
    }),
  ).toEqual({ identity: "private-1" });
  expect(
    second.getAdapter!("first")!.executionBinding!({
      tool: "first",
      params: {},
    }),
  ).toEqual({ identity: "private-2" });
  expect(
    await first.execute({ tool: "second", params: { destination: "one" } }),
  ).toMatchObject({ ok: true, output: "1" });
  expect(
    await second.execute({ tool: "first", params: { destination: "two" } }),
  ).toMatchObject({ ok: true, output: "2" });
  expect(
    registry.listNormalInvocations!()[0]!.contract.operations[0]!.input
      .properties.destination,
  ).toEqual({ type: "string", enum: ["one", "two"] });
  expect(JSON.stringify(first.listDefinitions())).not.toContain("private-");
  expect(first.getDefinition("disabled")).toBeUndefined();
});
