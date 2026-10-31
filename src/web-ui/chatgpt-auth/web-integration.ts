import type { IncomingMessage, ServerResponse } from "node:http";
import { getChatGptAuthService } from "../../provider-auth/chatgpt/service.js";
import { isLocalNativeFileRequest } from "../local-runtime/conversation-file-native-request.js";
import { ChatGptAuthRoutes } from "./routes.js";
import { ChatGptPublishedCallbacks } from "./published-callback.js";
import { isLocalChatGptManagementRequest } from "./request-authority.js";

/** Own published callbacks and attempt shutdown for one Runtime Web UI listener. */
export class ChatGptWebIntegration {
  private readonly callbacks = new ChatGptPublishedCallbacks();
  readonly routes: ChatGptAuthRoutes;
  constructor({ allowPublishedLoopback }: { allowPublishedLoopback: boolean }, service = getChatGptAuthService()) {
    this.routes = new ChatGptAuthRoutes(service, {
      isLocalRequest: (request) => isLocalChatGptManagementRequest(request, allowPublishedLoopback),
      callbackFactory: (request) => {
        if (isLocalNativeFileRequest(request)) return undefined;
        return this.callbacks.factory(request);
      },
    });
  }
  handle(request: IncomingMessage, response: ServerResponse, pathname: string): Promise<boolean> {
    return this.callbacks.handle(request, response, pathname);
  }
  close(): void {
    try { this.routes.close(); }
    finally { this.callbacks.close(); }
  }
}
