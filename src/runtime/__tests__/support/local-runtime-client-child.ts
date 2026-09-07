import type WebSocket from "ws";
import { createLocalRuntimeApplication } from "../../local-application.js";
import type { RuntimeConfig } from "../../ports.js";
import type { CreateSchedulerJobInput } from "../../scheduler/contracts.js";

type Command = { id: string; method: string; args: unknown[] };
let application: ReturnType<typeof createLocalRuntimeApplication> | undefined;

async function executeCommand(
  method: string,
  args: unknown[],
): Promise<unknown> {
  if (method === "init") {
    application = createLocalRuntimeApplication(args[0] as RuntimeConfig);
    application.subscribeScheduledEvents((event) =>
      process.send?.({ event, source: "scheduled" }),
    );
    await application.start();
    return { ownership: application.getOwnership(), pid: process.pid };
  }
  if (!application) throw new Error("child_application_not_initialized");
  const { scheduler, sessions } = application.services;
  switch (method) {
    case "createJob":
      return scheduler.create(args[0] as CreateSchedulerJobInput);
    case "listJobs":
      return scheduler.list();
    case "listRuns":
      return scheduler.listRuns();
    case "runNow":
      return scheduler.runNow(String(args[0]));
    case "cancelJob":
      return scheduler.cancel(String(args[0]));
    case "getSession":
      return sessions.getSessionById(String(args[0]));
    case "deleteSession":
      return sessions.deleteSession(String(args[0]));
    case "appendMessage":
      return sessions.appendMessage(
        String(args[0]),
        "assistant",
        String(args[1]),
      );
    case "runRequest": {
      const socket = {
        send(data: string) {
          process.send?.({ event: JSON.parse(data), source: "request" });
        },
      } as WebSocket;
      return application.requests.handle(socket, {
        type: "run_request",
        requestId: String(args[0]),
        sessionId: "session",
        text: String(args[1]),
        agentMode: "reasoning",
        toolPermissionMode: "full_access",
        modelPreference: { profileId: "scheduled-model", scope: "all" },
      });
    }
    case "stop":
      await application.stop();
      return true;
    default:
      throw new Error(`unknown_child_command:${method}`);
  }
}

process.on("message", (message: Command) => {
  void executeCommand(message.method, message.args).then(
    (value) => {
      process.send?.({ id: message.id, value }, () => {
        if (message.method === "stop") process.disconnect?.();
      });
    },
    (error) =>
      process.send?.({
        id: message.id,
        error: error instanceof Error ? error.message : String(error),
      }),
  );
});
process.on("disconnect", () => {
  void application?.stop().finally(() => process.exit(0));
});
