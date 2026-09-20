import { describe, expect, test } from "vitest";
import { failureResult, successResult } from "../../plugin-sdk/index.js";
import { attachHostEvidence } from "../../../plugins/system/source/host-evidence.js";
import { systemProcessResult } from "../../../plugins/system/source/process-result.js";
import type { HostIdentity } from "../../../plugins/system/source/companion/protocol.js";
import { HOST_OPERATIONS } from "../../../plugins/system/source/companion/protocol.js";
import {
  buildToolStartEventMetadata,
  buildToolCompletedEventMetadata,
} from "../../capabilities/tool-event-metadata.js";
import { systemDisplayDefinition } from "./support/system-tool-display-fixture.js";

const hostId = "550e8400-e29b-41d4-a716-446655440000";
const identity: HostIdentity = {
  name: "Paired host",
  os: "windows",
  user: "owner",
  homeDir: "C:\\Users\\owner",
};

describe("companion evidence preserves proof without exposing connection identity", () => {
  test.each(HOST_OPERATIONS)(
    "%s omits connection controls and identifiers from model receipts",
    (operation) => {
      const definition = systemDisplayDefinition(operation);
      const call = { tool: operation, params: { target: "windows" } };
      expect(buildToolStartEventMetadata(call, definition)).not.toHaveProperty(
        "hostId",
      );
      const result = attachHostEvidence(
        successResult({ output: "Fixture evidence." }),
        hostId,
        identity,
      );
      expect(
        buildToolCompletedEventMetadata(
          call,
          { tool: operation, ...result },
          definition,
        ),
      ).toMatchObject({
        transport: "host_companion",
      });
      expect(JSON.stringify(result)).not.toContain(hostId);
      expect(JSON.stringify(result)).not.toContain(identity.name);
      expect(result.data).not.toHaveProperty("hostIdentity");
    },
  );

  test("a launch receipt changes process namespace without inventing an application outcome", () => {
    const stdout = "in runtime OS namespace. is literal program output";
    const native = systemProcessResult(
      {
        id: "windows",
        transport: "native",
        shell: "C:\\Windows\\powershell.exe",
      },
      {
        exitCode: 0,
        stdout,
        stderr: "",
        status: "completed",
        outputTruncated: false,
        spawnedProcess: {
          pid: 81,
          pidNamespace: "runtime_os",
          executable: "powershell.exe",
          identitySource: "spawn_arguments",
        },
      },
      "launch_request_dispatch",
      { id: "App!Main", name: "App", target: "windows" },
    );
    const result = attachHostEvidence(native, hostId, identity);
    expect(result).toMatchObject({
      ok: true,
      stdout,
      data: {
        transport: "host_companion",
        nativeTransport: "native",
        evidenceScope: "launch_request_dispatch",
        independentOutcomeCheck: "not_performed",
        spawnedProcess: {
          pid: 81,
          pidNamespace: "companion_os",
          executable: "powershell.exe",
          identitySource: "spawn_arguments",
        },
      },
    });
    expect(result.output).toContain("PID 81 in companion OS namespace.");
    expect(result.output).toContain(stdout);
    expect(result.data).not.toHaveProperty("window");
    expect(result.data).not.toHaveProperty("applicationRunning");
    expect(result.data).not.toHaveProperty("mutationEvidence");
    expect(native.data?.spawnedProcess).toMatchObject({
      pidNamespace: "runtime_os",
    });
  });

  test("result-owned connection identity fields cannot leak into model evidence", () => {
    const native = successResult({
      output: "Observed catalog.",
      data: {
        hostId: "another-host",
        connectionId: "private-connection",
        hostIdentity: { name: "wrong" },
        transport: "native",
      },
    });
    const result = attachHostEvidence(native, hostId, identity);
    expect(result).toMatchObject({ data: { transport: "host_companion" } });
    expect(result.data).not.toHaveProperty("hostId");
    expect(result.data).not.toHaveProperty("hostIdentity");
    expect(result.data).not.toHaveProperty("connectionId");
  });

  test("native failure retains its exact error and failure semantics", () => {
    const native = failureResult({
      errorCode: "system_authorization_required",
      message: "Native authorization is required.",
      data: { humanActionRequired: true },
    });
    expect(attachHostEvidence(native, hostId, identity)).toMatchObject({
      ok: false,
      producedNewInformation: false,
      errorCode: "system_authorization_required",
      error: "Native authorization is required.",
      data: { humanActionRequired: true, transport: "host_companion" },
    });
  });
});
