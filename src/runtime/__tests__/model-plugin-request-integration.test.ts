import { afterEach, expect, test, vi } from "vitest";
import type { SessionRecord } from "../../sessions/types.js";
import type { LocalPendingToolApproval } from "../local-host/request-approval-contracts.js";
import { resetDebugLoggerConfig } from "../observability/debug-logger.js";
import type { RequestExecutionScope } from "../request/execution-scope.js";
import { createModelPluginRequestFixture } from "./support/model-plugin-request-fixture.js";

const fixtures: Awaited<ReturnType<typeof createModelPluginRequestFixture>>[] =
  [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0).reverse()) await fixture.dispose();
  vi.restoreAllMocks();
  resetDebugLoggerConfig();
});

function offered(request: RequestExecutionScope) {
  return request.workerCapabilities.provider
    .getDescriptors()
    .map((entry) => entry.capabilityId);
}

const policies = ["execution-agent-v1", "supervisor-worker-v1"] as const;

test.each(policies)(
  "%s filters the real request provider without leaking between concurrent profiles",
  async (policy) => {
    const fixture = await createModelPluginRequestFixture(policy);
    fixtures.push(fixture);
    const owner = await fixture.start();
    await Promise.all([
      fixture.run(owner, "restricted-request", "restricted"),
      fixture.run(
        owner,
        "unrestricted-request",
        "unrestricted",
        "blocked_effect",
      ),
    ]);
    const restricted = fixture.scopes.find(
      (request) => request.requestId === "restricted-request",
    )!;
    const unrestricted = fixture.scopes.find(
      (request) => request.requestId === "unrestricted-request",
    )!;
    expect(restricted.executionPolicy.authority.id).toBe(policy);
    expect(unrestricted.executionPolicy.authority.id).toBe(policy);
    expect(restricted.executionPolicySelection).toMatchObject({
      primaryProfileId: "restricted",
      plugins: { deny: ["blocked-plugin"] },
    });
    expect(unrestricted.executionPolicySelection).not.toHaveProperty("plugins");
    expect(offered(restricted)).toEqual(["allowed_effect"]);
    expect(offered(unrestricted)).toEqual(["allowed_effect", "blocked_effect"]);
    expect(
      restricted.workerCapabilities.provider
        .getAdapters()
        .map((adapter) => adapter.descriptor.capabilityId),
    ).toEqual(["allowed_effect"]);
    expect(fixture.effects.allowed).toHaveBeenCalledOnce();
    expect(fixture.effects.blocked).toHaveBeenCalledOnce();
    for (const requestId of ["restricted-request", "unrestricted-request"]) {
      const session = (await owner.call(
        "sessions.getSessionById",
        [requestId],
        fixture.peer,
      )) as SessionRecord;
      expect(
        session.messages.some((message) => message.role === "assistant"),
      ).toBe(true);
    }
  },
);

test.each(policies)(
  "%s uses the effective primary profile when defaults override the client preference",
  async (policy) => {
    const fixture = await createModelPluginRequestFixture(policy, true);
    fixtures.push(fixture);
    const owner = await fixture.start();
    await fixture.run(owner, "overridden-request", "unrestricted");
    const request = fixture.scopes.find(
      (scope) => scope.requestId === "overridden-request",
    )!;
    expect(request.modelPreference?.profileId).toBe("unrestricted");
    expect(request.executionPolicySelection?.primaryProfileId).toBe(
      "restricted",
    );
    expect(offered(request)).toEqual(["allowed_effect"]);
    expect(fixture.effects.allowed).toHaveBeenCalledOnce();
    expect(fixture.effects.blocked).not.toHaveBeenCalled();
  },
);

test.each(policies)(
  "%s cannot execute a denied operation supplied by model output",
  async (policy) => {
    const fixture = await createModelPluginRequestFixture(policy);
    fixtures.push(fixture);
    const owner = await fixture.start();
    await fixture.run(owner, "denied-request", "restricted", "blocked_effect");
    const request = fixture.scopes.find(
      (scope) => scope.requestId === "denied-request",
    )!;
    expect(offered(request)).toEqual(["allowed_effect"]);
    const script = fixture.scripts.get("denied-request")!;
    const outputs = await Promise.all(
      script.invoke.mock.results
        .filter((result) => result.type === "return")
        .map((result) => Promise.resolve(result.value).catch(() => undefined)),
    );
    expect(
      outputs.some((output) =>
        output?.text.includes('"capabilityId":"blocked_effect"'),
      ),
    ).toBe(true);
    expect(fixture.effects.blocked).not.toHaveBeenCalled();
    expect(fixture.effects.allowed).not.toHaveBeenCalled();
  },
);

test.each(policies)(
  "%s restores the saved model restriction after approval and owner restart",
  async (policy) => {
    const fixture = await createModelPluginRequestFixture(policy);
    fixtures.push(fixture);
    const owner = await fixture.start();
    expect(
      await fixture.run(
        owner,
        "saved-request",
        undefined,
        "allowed_effect",
        true,
      ),
    ).toMatchObject({ kind: "awaiting_approval" });
    const pending = (await owner.call(
      "request.approvals",
      ["saved-request"],
      fixture.peer,
    )) as LocalPendingToolApproval[];
    expect(pending).toHaveLength(1);
    expect(fixture.effects.allowed).not.toHaveBeenCalled();
    const initial = fixture.scopes.find(
      (request) => request.requestId === "saved-request",
    )!;
    expect(offered(initial)).toEqual(["allowed_effect"]);
    await owner.stop();
    await owner.whenIdle?.();

    // The resumed request must keep its captured restriction, including preflight.
    // New requests independently use the newly configured restriction.
    fixture.config.modelExecutionPolicies = {
      ...fixture.config.modelExecutionPolicies,
      restricted: { policy, plugins: { deny: ["allowed-plugin"] } },
    };
    const resumedOwner = await fixture.start();
    const approval = pending[0]!;
    expect(
      await resumedOwner.call(
        "request.approval.decide",
        [
          {
            sessionId: "saved-request",
            requestId: "saved-request",
            approvalId: approval.request.approvalId,
            ...approval.wait!,
            commandId: "approve-saved-effect",
            approved: true,
          },
        ],
        fixture.peer,
      ),
    ).toEqual({ accepted: true });
    await resumedOwner.whenIdle?.();
    expect(fixture.effects.allowed).toHaveBeenCalledOnce();
    expect(fixture.effects.blocked).not.toHaveBeenCalled();
    const resumedScopes = fixture.scopes.filter(
      (request) => request.requestId === "saved-request",
    );
    expect(resumedScopes.length).toBeGreaterThan(1);
    for (const request of resumedScopes) {
      expect(request.executionPolicySelection?.plugins).toEqual({
        deny: ["blocked-plugin"],
      });
      expect(offered(request)).toEqual(["allowed_effect"]);
    }
    const savedSession = (await resumedOwner.call(
      "sessions.getSessionById",
      ["saved-request"],
      fixture.peer,
    )) as SessionRecord;
    expect(
      savedSession.requests?.find(
        (request) => request.requestId === "saved-request",
      )?.status,
    ).toBe("completed");

    await fixture.run(
      resumedOwner,
      "fresh-request",
      undefined,
      "blocked_effect",
    );
    const fresh = fixture.scopes.find(
      (request) => request.requestId === "fresh-request",
    )!;
    expect(offered(fresh)).toEqual(["blocked_effect"]);
    expect(fixture.effects.blocked).toHaveBeenCalledOnce();
  },
);
