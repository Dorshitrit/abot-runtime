import { afterEach, expect, test, vi } from "vitest";
import { connectRuntimeObservations } from "../adapters/runtime-observation-connection.js";
import { readRuntimeCollectionSource } from "../../computer-access/observation-source.js";
const boundary = vi.hoisted(() => ({
  consent: vi.fn(), native: vi.fn(async () => ({ close() {} })), companion: vi.fn(async () => ({ close() {} })),
  source: vi.fn(),
}));
vi.mock("../../computer-access/collection-consent.js", () => ({ requireCollectionConsent: boundary.consent }));
vi.mock("../../computer-access/native-observation-connection.js", () => ({ connectNativeObservations: boundary.native }));
vi.mock("../../computer-access/companion/observation-client.js", () => ({ connectHostObservations: boundary.companion }));
vi.mock("../../computer-access/observation-source.js", async (original) => {
  const actual = await original<typeof import("../../computer-access/observation-source.js")>();
  return { ...actual, readRuntimeCollectionSource: (platform?: NodeJS.Platform) => platform ? actual.readRuntimeCollectionSource(platform) : boundary.source() };
});
afterEach(() => vi.clearAllMocks());
const options = () => ({ rootDir: "installation", ownerId: "dev", leaseId: "lease",
  abortSignal: new AbortController().signal, excludedApplications: [], onEvent: vi.fn() });

test.each(["win32", "linux", "darwin"] as const)("%s requires installation awareness before touching either transport", async (platform) => {
  boundary.source.mockReturnValue(readRuntimeCollectionSource(platform));
  boundary.consent.mockImplementationOnce(() => { throw new Error("collection_consent_required"); });
  await expect(connectRuntimeObservations(options())).rejects.toThrow("collection_consent_required");
  expect(boundary.native).not.toHaveBeenCalled(); expect(boundary.companion).not.toHaveBeenCalled();
});

test.each(["win32", "linux", "darwin", "freebsd"] as const)("%s uses only its server-selected transport after acknowledgment", async (platform) => {
  boundary.source.mockReturnValue(readRuntimeCollectionSource(platform));
  const input = options(); await connectRuntimeObservations(input);
  expect(boundary.consent).toHaveBeenCalledExactlyOnceWith(input.rootDir);
  const selected = platform === "win32" ? boundary.native : boundary.companion;
  const unused = platform === "win32" ? boundary.companion : boundary.native;
  expect(selected).toHaveBeenCalledExactlyOnceWith(input); expect(unused).not.toHaveBeenCalled();
});
