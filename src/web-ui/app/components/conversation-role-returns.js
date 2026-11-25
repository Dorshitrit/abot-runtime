import { createConversationRoleHistory } from "./conversation-role-history.js";
import { formatRoleReturnSummary } from "../lib/role-return-summary.js";

export function createConversationRoleReturns({ documentRoot = document } = {}) {
  const history = createConversationRoleHistory({
    documentRoot,
    kind: "return",
    textClassName: "conversation-role-return-summary",
    ariaLabel: "Planner results",
  });

  function createNode({ requestId, returns = [] }) {
    return history.createNode({
      requestId,
      items: returns.map((receipt) => ({
        id: receipt.id,
        label: receipt.outcome === "failed" ? "Planner failed" : "Returned result",
        text: formatRoleReturnSummary(receipt),
      })),
    });
  }

  return { createNode, forget: history.forget, reset: history.reset };
}
