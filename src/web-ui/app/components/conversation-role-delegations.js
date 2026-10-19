import { titleCaseEventValue } from "../lib/event-presentation.js";
import { createConversationRoleHistory } from "./conversation-role-history.js";

export function createConversationRoleDelegations({ documentRoot = document } = {}) {
  const history = createConversationRoleHistory({
    documentRoot,
    kind: "delegation",
    textClassName: "conversation-role-delegation-objective",
    ariaLabel: "Delegated work",
  });

  function createNode({ requestId, delegations = [] }) {
    return history.createNode({
      requestId,
      items: delegations.map((delegation) => ({
        id: delegation.id,
        label: `Delegated to ${titleCaseEventValue(delegation.childRole)}`,
        text: delegation.objective,
      })),
    });
  }

  return { createNode, forget: history.forget, reset: history.reset };
}
