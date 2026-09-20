import { describe, expect, test, vi } from "vitest";
import type {
  ToolModuleDeclaration,
  ToolModuleRequestPreparation,
} from "../../capabilities/tool-types.js";
import { createConfiguredToolRegistry } from "../capabilities/configured-tool-registry.js";
import { prepareRequestToolModules } from "../capabilities/request-module-preparation.js";

function moduleDeclaration(
  name: string,
  prepareRequest?: ToolModuleRequestPreparation,
): ToolModuleDeclaration {
  return {
    definition: { name, routingCapability: "semantic_lookup" },
    implementation: async () => ({
      ok: true,
      output: "local",
      producedNewInformation: true,
    }),
    ...(prepareRequest ? { prepareRequest } : {}),
    normalInvocation: {
      version: 1,
      operations: [
        {
          operationId: name,
          summary: "Perform the selected operation.",
          effect: "read_only",
          approval: "always",
          input: {
            type: "object",
            additionalProperties: false,
            required: ["destination"],
            properties: {
              destination: { type: "string", enum: ["first", "second"] },
            },
          },
        },
      ],
    },
  };
}

function narrowModule(
  module: ToolModuleDeclaration,
  destination: string,
): ToolModuleDeclaration {
  return {
    ...module,
    normalInvocation: {
      ...module.normalInvocation,
      operations: module.normalInvocation.operations.map((operation) => ({
        ...operation,
        summary: `Available destination: ${destination}.`,
        input: {
          ...operation.input,
          properties: { destination: { type: "string", enum: [destination] } },
        },
      })),
    },
  };
}

describe("request module availability preparation", () => {
  test("observes only selected modules once, keeps native modules, and isolates concurrent snapshots", async () => {
    let sequence = 0;
    const prepare = vi.fn<ToolModuleRequestPreparation>(async (modules) => {
      const target = sequence++ === 0 ? "first" : "second";
      await Promise.resolve();
      return modules
        .filter(({ definition }) => definition.name !== "unavailable")
        .map((module) => ({
          ...narrowModule(module, target),
          implementation: async () => ({
            ok: true,
            output: target,
            producedNewInformation: true,
          }),
        }));
    });
    const modules = [
      moduleDeclaration("visible", prepare),
      moduleDeclaration("unavailable", prepare),
      moduleDeclaration("local"),
    ];
    const base = createConfiguredToolRegistry(undefined, modules);
    const [first, second] = await Promise.all([
      base.prepareRequest!(),
      base.prepareRequest!(),
    ]);
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(
      prepare.mock.calls[0]![0].map(({ definition }) => definition.name),
    ).toEqual(["visible", "unavailable"]);
    expect(first.listDefinitions().map(({ name }) => name)).toEqual([
      "visible",
      "local",
    ]);
    expect(first.prepareRequest).toBeUndefined();
    expect(
      first.listNormalInvocations!()[0]!.contract.operations[0]!.input
        .properties.destination,
    ).toEqual({ type: "string", enum: ["first"] });
    expect(
      second.listNormalInvocations!()[0]!.contract.operations[0]!.input
        .properties.destination,
    ).toEqual({ type: "string", enum: ["second"] });
    expect(
      base.listNormalInvocations!()[0]!.contract.operations[0]!.input.properties
        .destination,
    ).toEqual({ type: "string", enum: ["first", "second"] });
    expect(
      await first.execute({
        tool: "visible",
        params: { destination: "first" },
      }),
    ).toMatchObject({ ok: true, output: "first" });
    expect(
      await second.execute({
        tool: "visible",
        params: { destination: "second" },
      }),
    ).toMatchObject({ ok: true, output: "second" });
  });

  test("empty selection cannot observe or restore disabled tools", async () => {
    const denied = vi.fn<ToolModuleRequestPreparation>(
      async (modules) => modules,
    );
    const hidden = moduleDeclaration("hidden", denied);
    const selected = [hidden].filter(() => false);
    expect(await prepareRequestToolModules(selected)).toEqual([]);
    expect(denied).not.toHaveBeenCalled();
    const prepare: ToolModuleRequestPreparation = async (modules) => [
      ...modules,
      hidden,
    ];
    await expect(
      prepareRequestToolModules([moduleDeclaration("visible", prepare)]),
    ).rejects.toThrow("unselected tool");
  });

  test.each(["effect", "approval", "controls", "enum"])(
    "cannot widen %s during preparation",
    async (field) => {
      const prepare: ToolModuleRequestPreparation = async ([module]) => [
        {
          ...module!,
          normalInvocation: {
            version: 1,
            operations: module!.normalInvocation.operations.map((op) => ({
              ...op,
              ...(field === "effect" ? { effect: "mixed" as const } : {}),
              ...(field === "approval"
                ? { approval: "request_policy" as const }
                : {}),
              ...(field === "controls"
                ? { input: { ...op.input, required: [], properties: {} } }
                : {}),
              ...(field === "enum"
                ? {
                    input: {
                      ...op.input,
                      properties: {
                        destination: {
                          type: "string" as const,
                          enum: ["third"],
                        },
                      },
                    },
                  }
                : {}),
            })),
          },
        },
      ];
      await expect(
        prepareRequestToolModules([moduleDeclaration("visible", prepare)]),
      ).rejects.toThrow(/Request preparation/);
    },
  );

  test("plugin receives frozen detached contracts and failures do not mutate shared registry", async () => {
    const prepare: ToolModuleRequestPreparation = async ([module]) => {
      expect(
        Object.isFrozen(
          module!.normalInvocation.operations[0]!.input.properties,
        ),
      ).toBe(true);
      throw new Error("observation failed");
    };
    const modules = [moduleDeclaration("visible", prepare)];
    const before = JSON.stringify(modules);
    await expect(prepareRequestToolModules(modules)).rejects.toThrow(
      "observation failed",
    );
    expect(JSON.stringify(modules)).toBe(before);
  });
});
