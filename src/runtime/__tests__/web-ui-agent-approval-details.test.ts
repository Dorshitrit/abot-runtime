import { describe, expect, test } from "vitest";
import { ContextElement } from "./support/composer-context-window-dom.js";
// @ts-expect-error Browser-only module.
import { createAgentApprovalDetails } from "../../web-ui/app/components/agents/approval-details.js";
// @ts-expect-error Browser-only module.
import { renderAgentApprovals } from "../../web-ui/app/components/agents/conversation.js";

function fixture() {
  const nodes = new Map<string, ContextElement>();
  const documentRoot = { createElement: (tag: string) => new ContextElement(tag) };
  const renderDetails = createAgentApprovalDetails({ documentRoot });
  const root = { querySelector: (selector: string) => nodes.get(selector) || null };
  function select() {
    nodes.clear();
    const node = new ContextElement("div");
    nodes.set('[data-agent-approval-details="0"]', node);
    return node;
  }
  return { node: select(), select, render: (approvals: unknown[]) => renderDetails(root, approvals) };
}

function approval(meta?: Record<string, unknown>) {
  return {
    sessionId: "session-1",
    request: {
      requestId: "request-1", approvalId: "approval-1",
      call: { tool: "exec", params: { command: "private executable sidecar" }, clientStatus: "Inspect the project" },
      ...(meta ? { meta } : {}),
    },
    wait: { generation: 2, waitId: "wait-1", revision: 4 },
  };
}

function descendants(node: ContextElement): ContextElement[] {
  return [node, ...node.children.flatMap(descendants)];
}

describe("Agent approval recorded input details", () => {
  test("renders the exact long prepared command and working directory as inert text", () => {
    const h = fixture();
    const command = "  printf '<unsafe>&שלום'\n" + "x".repeat(24000) + "\n  ";
    const cwd = " /outside root/<project>/" + "folder ".repeat(600) + " ";
    h.render([approval({ command, commandTruncated: false, cwd, timeoutMs: 10000, elevated: true })]);
    const nodes = descendants(h.node);
    expect(h.node.querySelector("pre")?.textContent).toBe(command);
    expect(nodes.some(node => node.tagName === "bdi" && node.textContent === cwd)).toBe(true);
    expect(h.node.textContent).toContain("Prepared command");
    expect(h.node.textContent).toContain("Working directory");
    expect(h.node.textContent).toContain("Timeout (ms)10000");
    expect(h.node.textContent).toContain("ElevatedYes");
    expect(h.node.textContent).not.toContain("Sent command");
    expect(h.node.querySelector("unsafe")).toBeNull();
    expect(h.node.querySelector("button")).toBeNull();
  });

  test("uses the same declared fields for a non-EXEC tool without exposing opaque parameters", () => {
    const h = fixture();
    const item = approval({ path: "/project/<unsafe>.txt", inputPreview: "<script>text</script>", contentLength: 21 });
    item.request.call.tool = "write_file";
    h.render([item]);
    expect(h.node.textContent).toContain("Path/project/<unsafe>.txt");
    expect(h.node.textContent).toContain("Prepared content excerpt<script>text</script>");
    expect(h.node.textContent).toContain("Content characters21");
    expect(h.node.textContent).not.toContain("private executable sidecar");
    expect(h.node.querySelector("script")).toBeNull();
  });

  test("labels incomplete commands as excerpts and never promotes opaque params into command text", () => {
    const h = fixture();
    h.render([approval({ command: "printf 'partial", commandTruncated: true })]);
    expect(h.node.textContent).toContain("Prepared command excerpt");
    h.render([approval({ params: { command: "string(len=2000)" } })]);
    expect(h.node.textContent).toContain("Command detailsNot recorded in this event");
    expect(h.node.textContent).not.toContain("string(len=2000)");
    expect(h.node.textContent).not.toContain("private executable sidecar");
    expect(h.node.querySelector("pre")).toBeNull();
  });

  test("explicitly states when no recorded input evidence is available", () => {
    const h = fixture();
    h.render([approval()]);
    expect(h.node.textContent).toBe("Input details were not recorded for this approval.");
    expect(h.node.textContent).not.toContain("private executable sidecar");
  });

  test("restored saved presentation renders the same prepared evidence", () => {
    const h = fixture();
    const live = approval({ command: "  pwd\n", commandTruncated: false, cwd: " /workspace " });
    h.render([live]);
    const expected = h.node.textContent;
    const restored = JSON.parse(JSON.stringify({ sessionId: live.sessionId, presentation: live.request, wait: live.wait }));
    h.render([restored]);
    expect(h.node.textContent).toBe(expected);
    expect(h.node.querySelector("pre")?.textContent).toBe("  pwd\n");
  });

  test("unchanged polling preserves the evidence DOM and command scroll position", () => {
    const h = fixture();
    const item = approval({ command: "pwd\n".repeat(100), commandTruncated: false });
    h.render([item]);
    const evidence = h.node.children[0];
    const command = h.node.querySelector("pre") as ContextElement & { scrollTop: number };
    command.scrollTop = 73;
    h.render([JSON.parse(JSON.stringify(item))]);
    expect(h.node.children[0]).toBe(evidence);
    expect(h.node.querySelector("pre")).toBe(command);
    expect(command.scrollTop).toBe(73);
  });

  test("refreshes evidence when content, approval identity, or wait identity changes", () => {
    const h = fixture();
    const item = approval({ command: "pwd", commandTruncated: false });
    h.render([item]);
    for (const change of [
      () => { item.request.meta = { command: "ls", commandTruncated: false }; },
      () => { item.request.approvalId = "approval-2"; },
      () => { item.wait.waitId = "wait-2"; },
      () => { item.wait.revision++; },
      () => { item.wait.generation++; },
      () => { item.sessionId = "session-2"; },
    ]) {
      const old = h.node.children[0];
      change(); h.render([item]);
      expect(h.node.children[0]).not.toBe(old);
      expect(h.node.querySelector("pre")?.textContent).toBe("ls");
    }
  });

  test("a newly selected workspace cannot reuse another scope's evidence node", () => {
    const h = fixture();
    const item = approval({ command: "pwd", commandTruncated: false });
    h.render([item]);
    const old = h.node.children[0];
    const current = h.select();
    expect(current.children).toHaveLength(0);
    h.render([item]);
    expect(current.children[0]).not.toBe(old);
    expect(current.querySelector("pre")?.textContent).toBe("pwd");
  });

  test("keeps decision indexes and booleans while showing the tool and escaped client summary", () => {
    const first = approval();
    first.request.call.clientStatus = "<script>Inspect the project</script>";
    const markup = renderAgentApprovals([first, approval()]);
    expect(markup).toContain("terminal approval required");
    expect(markup).toContain("&lt;script&gt;Inspect the project&lt;/script&gt;");
    expect(markup).not.toContain("<script>");
    for (const index of [0, 1]) {
      expect(markup).toContain(`data-agent-approval-details="${index}"`);
      expect(markup).toContain(`data-agent-approval="${index}" data-approved="true"`);
      expect(markup).toContain(`data-agent-approval="${index}" data-approved="false"`);
    }
  });
});
