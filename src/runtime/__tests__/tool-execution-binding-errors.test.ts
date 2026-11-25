import { describe, expect, test } from "vitest";
import { dynamicApprovalFixture } from "./support/dynamic-tool-approval-fixture.js";

const fallbackCode = "normal_invocation_execution_binding_unavailable";
const fallbackMessage = "The registered action could not bind its execution destination for this request.";

describe("execution binding failure evidence", () => {
  test.each(["sync", "async"])("preserves a %s plugin failure without approval or execution", async (timing) => {
    const error = Object.assign(new Error("The selected target changed. Select it again."), {
      code: "selected_target_changed", data: { privateDetail: "not-result-evidence" },
    });
    const binding = () => { throw error; };
    const f = dynamicApprovalFixture({ binding: timing === "sync" ? binding : async () => binding() });

    await expect(f.executor.execute(f.input)).resolves.toEqual({
      status: "rejected", code: error.code, message: error.message,
    });
    expect(f.nextApprovalId).not.toHaveBeenCalled();
    expect(f.requestApproval).not.toHaveBeenCalled();
    expect(f.implementation).not.toHaveBeenCalled();
  });

  test.each([undefined, 42, "INVALID_CODE", "has spaces", "a".repeat(129)])(
    "falls back for invalid code %j while retaining the error message", async (code) => {
      const error = Object.assign(new Error("The target cannot be loaded."), { code });
      const f = dynamicApprovalFixture({ binding: async () => { throw error; } });

      await expect(f.executor.execute(f.input)).resolves.toEqual({
        status: "rejected", code: fallbackCode, message: error.message,
      });
      expect(f.requestApproval).not.toHaveBeenCalled();
      expect(f.implementation).not.toHaveBeenCalled();
    },
  );

  test.each([null, "unstructured failure", { code: "untyped_error", message: "untyped message" }])(
    "falls back for a non-Error failure %j", async (error) => {
      const f = dynamicApprovalFixture({ binding: async () => { throw error; } });

      await expect(f.executor.execute(f.input)).resolves.toEqual({
        status: "rejected", code: fallbackCode, message: fallbackMessage,
      });
      expect(f.implementation).not.toHaveBeenCalled();
    },
  );

  test.each([undefined, null, 42, " \n"])("retains a valid code with unusable message %j", async (message) => {
    const error = Object.assign(new Error(), { code: "target_unavailable", message });
    const f = dynamicApprovalFixture({ binding: async () => { throw error; } });

    await expect(f.executor.execute(f.input)).resolves.toEqual({
      status: "rejected", code: error.code, message: fallbackMessage,
    });
    expect(f.implementation).not.toHaveBeenCalled();
  });

  test("propagates a plugin AbortError without turning it into tool evidence", async () => {
    const error = new DOMException("Cancelled by the plugin", "AbortError");
    const f = dynamicApprovalFixture({ binding: async () => { throw error; } });

    await expect(f.executor.execute(f.input)).rejects.toBe(error);
    expect(f.nextApprovalId).not.toHaveBeenCalled();
    expect(f.requestApproval).not.toHaveBeenCalled();
    expect(f.implementation).not.toHaveBeenCalled();
  });

  test("request cancellation takes precedence over a simultaneous plugin failure", async () => {
    const reason = new DOMException("Request cancelled", "AbortError");
    const error = Object.assign(new Error("Select the target again."), { code: "target_changed" });
    const f = dynamicApprovalFixture({ binding: async () => {
      f.abort.abort(reason);
      throw error;
    } });

    await expect(f.executor.execute(f.input)).rejects.toBe(reason);
    expect(f.requestApproval).not.toHaveBeenCalled();
    expect(f.implementation).not.toHaveBeenCalled();
  });
});
