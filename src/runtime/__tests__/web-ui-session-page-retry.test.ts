import { expect, test, vi } from "vitest";
// @ts-expect-error Browser controller.
import { createSessionListPagination } from "../../web-ui/app/controllers/session-list-pagination.js";
import { ContextElement } from "./support/composer-context-window-dom.js";

class FooterElement extends ContextElement {
  get ownerDocument() { return { createElement: (tag: string): FooterElement => new FooterElement(tag) }; }
}
async function fixture() {
  const state = { sessions: [] as Array<{ id: string }>, sessionQuery: "" };
  const root = new FooterElement("section");
  const client = { listSessions: vi.fn() };
  const pagination = createSessionListPagination({
    state, dom: { sessionsList: root }, client, sessions: {}, selectedEnvironmentId: () => "dev",
    renderSessions: () => { root.replaceChildren(); pagination.renderFooter(); }, onSessionListState: vi.fn(),
  });
  client.listSessions.mockResolvedValueOnce({ sessions: [{ id: "old" }], nextCursor: "old-cursor" });
  await pagination.load();
  const retry = async () => {
    root.children.at(-1)!.dispatch("click");
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };
  return { state, client, pagination, root, retry };
}

test.each(["refresh", "search"])("a failed %s retries the first page without the previous cursor", async (operation) => {
  const f = await fixture();
  if (operation === "search") f.state.sessionQuery = "matching";
  f.client.listSessions.mockRejectedValueOnce(new Error("network unavailable"));
  await f.pagination.load();
  expect(f.state.sessions).toEqual([{ id: "old" }]);
  const calls = f.client.listSessions.mock.calls.length;
  await f.pagination.load(true);
  expect(f.client.listSessions).toHaveBeenCalledTimes(calls);
  f.client.listSessions.mockResolvedValueOnce({ sessions: [{ id: "matching" }], nextCursor: "new-cursor" });
  await f.retry();
  expect(f.client.listSessions).toHaveBeenLastCalledWith("dev", { query: f.state.sessionQuery, cursor: null });
  expect(f.state.sessions).toEqual([{ id: "matching" }]);
});

test("a failed continuation retries its cursor and retains the preceding page", async () => {
  const f = await fixture();
  f.client.listSessions.mockRejectedValueOnce(new Error("network unavailable"));
  await f.pagination.load(true);
  f.client.listSessions.mockResolvedValueOnce({ sessions: [{ id: "next" }], nextCursor: null });
  await f.retry();
  expect(f.client.listSessions).toHaveBeenLastCalledWith("dev", { query: "", cursor: "old-cursor" });
  expect(f.state.sessions.map((session) => session.id)).toEqual(["old", "next"]);
});
