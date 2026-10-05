import { expect, test, vi } from "vitest";
const permissionCommand = vi.hoisted(() => vi.fn(async () => {}));
const nativeState = vi.hoisted(() => vi.fn(() => { throw new Error("must not initialize pairing state"); }));
vi.mock("../../cli/host-permissions.js", () => ({ runHostPermissionsCli: permissionCommand }));
vi.mock("../../computer-access/companion/native-state.js", async (load) => ({
  ...await load<object>(), createNativeHostState: nativeState,
}));
import { runHostCompanionCli } from "../../cli/host-companion.js";

test("permission preparation branches before pairing storage and forwards only CLI arguments", async () => {
  await runHostCompanionCli(["permissions"]);
  await runHostCompanionCli(["permissions", "--request", "accessibility"]);
  expect(permissionCommand.mock.calls).toEqual([[[]], [["--request", "accessibility"]]]);
  expect(nativeState).not.toHaveBeenCalled();
});
