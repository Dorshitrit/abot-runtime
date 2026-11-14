import { ComposerSubmissionRefused } from "./composer-submission-lifecycle.js";
import {
  isComposerCommand,
  resolveComposerCommand,
} from "../lib/composer-command.js";
import { createComposerCommandMenu } from "../components/composer-command-menu.js";

export function createComposerCommands({
  state,
  client,
  lifecycle,
  queue,
  conversationSession,
  reportFailure,
  changed,
}) {
  let catalog;
  async function definitions() {
    if (!client.listRuntimeCommands)
      throw new Error("Commands are unavailable on this connection.");
    catalog ??= client
      .listRuntimeCommands()
      .then((result) => result.commands || [])
      .catch((error) => {
        catalog = undefined;
        throw error;
      });
    return catalog;
  }
  return {
    attachMenu: (options) =>
      createComposerCommandMenu({ ...options, definitions }),
    handles: isComposerCommand,
    submit({ draft, settings, activeRequestId, prepareSend }) {
      let command;
      return lifecycle
        .submit({
          draft,
          action: "send",
          settings,
          prepare: async (attempt) => {
            try {
              command = resolveComposerCommand(
                attempt.payload.text,
                await definitions(),
                activeRequestId,
              );
              if (attempt.payload.release)
                throw new Error(
                  "Send commands from a new draft, outside the message queue.",
                );
              if (attempt.payload.attachments.length)
                throw new Error("Commands do not accept attachments.");
              if ((await prepareSend(attempt.payload)) === false)
                throw new Error("Conversation navigation was cancelled.");
              await queue.prepareManualSend(attempt);
            } catch (error) {
              throw new ComposerSubmissionRefused(error.message, {
                cause: error,
              });
            }
          },
          execute: async (attempt) => {
            try {
              return await client.postChatMessage({
                ...attempt.settings,
                ...attempt.payload.scope,
                text: "",
                attachments: [],
                command,
              });
            } catch (error) {
              if (error.status >= 400 && error.status < 500)
                throw new ComposerSubmissionRefused(error.message, {
                  cause: error,
                });
              throw error;
            }
          },
          accepted: (attempt, requestId) =>
            conversationSession.activateRequestForScope(
              attempt.payload.scope,
              requestId,
              "command",
            ),
          prepareRestore: queue.prepareRestore,
        })
        .then((result) => {
          if (result.status === "refused")
            reportFailure(result.attempt.payload.scope, result.error.message);
          changed();
          return result;
        });
    },
  };
}
