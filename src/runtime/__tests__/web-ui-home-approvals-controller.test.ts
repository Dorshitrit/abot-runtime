import { describe, expect, test, vi } from "vitest";
// @ts-expect-error Browser-only module has no declaration surface.
import { createDashboardApprovalsController } from "../../web-ui/app/controllers/dashboard-approvals-controller.js";
// @ts-expect-error Browser-only module has no declaration surface.
import { renderDashboardApprovals } from "../../web-ui/app/components/dashboard/approvals.js";
import { ContextElement } from "./support/composer-context-window-dom.js";

class ApprovalElement extends ContextElement {
  get firstChild() {
    return this.children[0] || null;
  }
  readonly removals: ContextElement[] = [];

  removeChild(child: ContextElement) {
    const index = this.children.indexOf(child);
    if (index < 0) throw new Error("Child is not mounted");
    this.children.splice(index, 1);
    child.parentElement = null;
    this.removals.push(child);
    return child;
  }

  insertBefore(child: ContextElement, reference: ContextElement | null) {
    if (child.parentElement)
      (child.parentElement as ApprovalElement).removeChild(child);
    if (!reference) return this.appendChild(child);
    const index = this.children.indexOf(reference);
    if (index < 0) throw new Error("Reference is not mounted");
    child.parentElement = this;
    this.children.splice(index, 0, child);
    return child;
  }
}

function pending(sessionId = "first", environmentId = "prod") {
  return {
    environmentId,
    sessionId,
    requestId: `${sessionId}-request`,
    approvalId: `${sessionId}-approval`,
    event: {
      name: "tool.approval.required",
      requestId: `${sessionId}-request`,
      approvalId: `${sessionId}-approval`,
      tool: "system_command",
      meta: {
        command: "  echo '<script>inert</script>'\nsecond command",
        cwd: "/bound/workspace",
        computerName: "My computer",
      },
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (value: Error) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function fixture(supported = true) {
  let environmentId = "prod";
  const client = {
    supportsToolApprovals: () => supported,
    listToolApprovals: vi.fn(async (_environment: string) => ({
      approvals: [pending()],
    })),
    decideToolApproval: vi.fn(async (_decision: unknown) => ({})),
    loadSession: vi.fn(),
    markSessionRead: vi.fn(),
  };
  const render = vi.fn();
  const controller = createDashboardApprovalsController({
    client,
    getEnvironmentId: () => environmentId,
    render,
  });
  return {
    client,
    controller,
    render,
    setEnvironment: (value: string) => {
      environmentId = value;
      controller.invalidate();
    },
  };
}

describe("Home approval lifecycle", () => {
  test("a fresh Home discovers another session and submits its exact scope without opening or reading it", async () => {
    const f = fixture();
    await f.controller.refresh();
    expect(f.controller.snapshot().approvals[0]).toMatchObject(pending());
    f.client.listToolApprovals.mockResolvedValueOnce({ approvals: [] });
    expect(await f.controller.submit(pending(), false)).toBe(true);
    expect(f.client.decideToolApproval).toHaveBeenCalledExactlyOnceWith({
      environmentId: "prod",
      sessionId: "first",
      requestId: "first-request",
      approvalId: "first-approval",
      approved: false,
    });
    expect(f.controller.snapshot().approvals).toEqual([]);
    expect(f.client.loadSession).not.toHaveBeenCalled();
    expect(f.client.markSessionRead).not.toHaveBeenCalled();
  });

  test("ignores late environment and overlapping read responses", async () => {
    const f = fixture();
    const old = deferred<{ approvals: ReturnType<typeof pending>[] }>();
    f.client.listToolApprovals.mockReturnValueOnce(old.promise);
    const oldRead = f.controller.refresh();
    f.setEnvironment("dev");
    f.client.listToolApprovals.mockResolvedValueOnce({
      approvals: [pending("new", "dev")],
    });
    await f.controller.refresh();
    old.resolve({ approvals: [pending()] });
    await oldRead;
    expect(f.controller.snapshot().approvals).toEqual([
      expect.objectContaining({ sessionId: "new", environmentId: "dev" }),
    ]);
    expect(await f.controller.submit(pending(), true)).toBe(false);
    expect(f.client.decideToolApproval).not.toHaveBeenCalled();
  });

  test("blocks duplicate submissions and isolates late approval failure from the next environment", async () => {
    const f = fixture();
    await f.controller.refresh();
    const result = deferred<unknown>();
    f.client.decideToolApproval.mockReturnValueOnce(
      result.promise as Promise<object>,
    );
    const submitted = f.controller.submit(pending(), true);
    expect(f.controller.snapshot().approvals[0].submitted).toBe(true);
    expect(await f.controller.submit(pending(), true)).toBe(false);
    f.setEnvironment("dev");
    f.client.listToolApprovals.mockResolvedValueOnce({
      approvals: [pending("next", "dev")],
    });
    await f.controller.refresh();
    result.reject(new Error("Old approval failed"));
    await submitted;
    expect(f.controller.snapshot()).toMatchObject({
      approvalDecisionError: "",
      approvals: [
        expect.objectContaining({ sessionId: "next", submitted: false }),
      ],
    });
    expect(f.client.decideToolApproval).toHaveBeenCalledOnce();
  });

  test("a stale decision is refreshed and keeps explicit failure feedback", async () => {
    const f = fixture();
    await f.controller.refresh();
    f.client.decideToolApproval.mockRejectedValueOnce(
      new Error("This action is no longer waiting."),
    );
    f.client.listToolApprovals.mockResolvedValueOnce({ approvals: [] });
    expect(await f.controller.submit(pending(), true)).toBe(false);
    expect(f.controller.snapshot()).toMatchObject({
      approvals: [],
      approvalDecisionError: "This action is no longer waiting.",
    });
    f.client.listToolApprovals.mockRejectedValueOnce(new Error("Offline"));
    await f.controller.refresh();
    expect(f.controller.snapshot().approvalsError).toBe("Offline");
  });

  test("bridge availability never invents pending approvals", async () => {
    const f = fixture(false);
    await f.controller.refresh();
    expect(f.controller.snapshot()).toMatchObject({
      supportsToolApprovals: false,
      approvals: [],
      loadingApprovals: false,
    });
    expect(f.client.listToolApprovals).not.toHaveBeenCalled();
  });
});

function descendants(root: ContextElement): ContextElement[] {
  return [root, ...root.children.flatMap(descendants)];
}

test("routine Home refreshes preserve the approval DOM and command scroll while a user reviews it", () => {
  const root = new ApprovalElement("section");
  const options = {
    root,
    onDecision: vi.fn(),
    documentRoot: { createElement: (tag: string) => new ApprovalElement(tag) },
    snapshot: {
      approvals: [pending()],
      sessions: [{ id: "first", title: "Reviewing" }],
      loadingApprovals: false,
    },
  };
  renderDashboardApprovals(options);
  const command = Object.assign(root.querySelector("pre")!, { scrollTop: 40 });
  renderDashboardApprovals({
    ...options,
    snapshot: { ...options.snapshot, runs: [{ id: "unrelated-job" }] },
  });
  expect(root.querySelector("pre")).toBe(command);
  expect(command.scrollTop).toBe(40);
  root.replaceChildren();
  renderDashboardApprovals(options);
  expect(root.querySelector("pre")).not.toBeNull();
});

test("another approval arriving, submitting or resolving keeps the reviewed native disclosure mounted and open", () => {
  const root = new ApprovalElement("section");
  const first = pending();
  const second = pending("second");
  const options = {
    root,
    onDecision: vi.fn(),
    documentRoot: { createElement: (tag: string) => new ApprovalElement(tag) },
    snapshot: { approvals: [first], sessions: [], loadingApprovals: false },
  };
  renderDashboardApprovals(options);
  const reviewed = root.querySelector(".home-approval")!;
  const details = Object.assign(reviewed.querySelector("details")!, {
    open: true,
  });
  const command = Object.assign(reviewed.querySelector("pre")!, {
    scrollTop: 60,
  });
  for (const approvals of [
    [second, first],
    [{ ...second, submitted: true }, first],
    [first],
  ]) {
    renderDashboardApprovals({
      ...options,
      snapshot: { ...options.snapshot, approvals },
    });
    expect(root.contains(reviewed)).toBe(true);
    expect(reviewed.querySelector("details")).toBe(details);
    expect(details.open).toBe(true);
    expect(command.scrollTop).toBe(60);
    expect(root.removals).not.toContain(reviewed);
  }
  renderDashboardApprovals({
    ...options,
    snapshot: { ...options.snapshot, approvals: [pending("first", "dev")] },
  });
  expect(root.contains(reviewed)).toBe(false);
  expect(root.querySelector("details")).not.toBe(details);
});

test("Home reuses inert command evidence, session titles and explicit approval/rejection controls", () => {
  const root = new ApprovalElement("section");
  const onDecision = vi.fn();
  const first = pending();
  const second = pending("second");
  renderDashboardApprovals({
    root,
    onDecision,
    documentRoot: { createElement: (tag: string) => new ApprovalElement(tag) },
    snapshot: {
      approvals: [first, second],
      sessions: [{ id: "first", title: "My conversation" }],
      supportsToolApprovals: true,
    },
  });
  expect(root.textContent).toContain("My conversation");
  expect(
    root
      .querySelector(".approval-message-header")
      ?.querySelector(".home-approval-conversation")?.textContent,
  ).toBe("My conversation");
  expect(root.textContent).toContain("Prepared command");
  expect(root.textContent).toContain("/bound/workspace");
  expect(root.textContent).toContain("My computer");
  expect(root.querySelector("script")).toBeNull();
  expect(root.querySelector("pre")?.textContent).toBe(first.event.meta.command);
  expect(onDecision).not.toHaveBeenCalled();
  const buttons = descendants(root).filter((node) => node.tagName === "button");
  buttons.find((button) => button.textContent === "Approve")!.dispatch("click");
  expect(onDecision).toHaveBeenLastCalledWith(first, true);
  buttons
    .filter((button) => button.textContent === "Reject")[1]!
    .dispatch("click");
  expect(onDecision).toHaveBeenLastCalledWith(second, false);
});
