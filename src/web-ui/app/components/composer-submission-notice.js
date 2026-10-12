/** Manual review is explicit; displaying an uncertain outcome never retries it. */
export function createComposerSubmissionNotice({ form, review, recover }) {
  const root = form.ownerDocument.createElement("div");
  root.className = "composer-submission-notice";
  root.setAttribute("role", "status");
  root.hidden = true;
  form.appendChild(root);
  return {
    render(attempts, recovery) {
      root.replaceChildren();
      root.hidden = attempts.length === 0 && !recovery;
      for (const attempt of attempts) {
        const row = form.ownerDocument.createElement("div");
        const label = form.ownerDocument.createElement("span");
        label.textContent = attempt.action === "send_next"
          ? "Queue save could not be confirmed. Reload and check Send next before repeating this message."
          : "A message could not be confirmed. Check the conversation before sending it again.";
        row.appendChild(label);
        if (attempt.action !== "send_next") {
          const button = form.ownerDocument.createElement("button");
          button.type = "button";
          button.textContent = "Review message";
          button.addEventListener("click", async () => {
            button.disabled = true;
            try { await review(attempt); }
            finally { button.disabled = false; }
          });
          row.appendChild(button);
        }
        root.appendChild(row);
      }
      if (!recovery) return;
      const row = form.ownerDocument.createElement("div");
      const label = form.ownerDocument.createElement("span");
      label.textContent = recovery.draftEmpty
        ? "A queued message is paused and ready for manual review."
        : "Finish or clear your current draft to review the paused queued message.";
      const button = form.ownerDocument.createElement("button");
      button.type = "button";
      button.textContent = "Review queued message";
      button.disabled = !recovery.draftEmpty;
      button.addEventListener("click", async () => {
        button.disabled = true;
        try { await recover(recovery.scope); }
        finally { button.disabled = !recovery.draftEmpty; }
      });
      row.appendChild(label); row.appendChild(button); root.appendChild(row);
    },
  };
}
