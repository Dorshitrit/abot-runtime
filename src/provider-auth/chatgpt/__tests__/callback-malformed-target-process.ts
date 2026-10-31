import { get } from "node:http";
import { createChatGptCallback } from "../callback.js";

type CallbackResponse = {
  status: number | undefined;
  body: string;
  cacheControl: string | undefined;
  contentType: string | undefined;
};

function requestRawCallback(redirectUri: string, target: string): Promise<CallbackResponse> {
  const address = new URL(redirectUri);
  return new Promise((resolve, reject) => {
    // Supplying path directly preserves the malformed target instead of URL-normalizing it.
    const request = get({
      hostname: address.hostname,
      port: address.port,
      path: target,
      agent: false,
      headers: { connection: "close" },
    }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => { body += chunk; });
      response.once("error", reject);
      response.once("end", () => resolve({
        status: response.statusCode,
        body,
        cacheControl: response.headers["cache-control"],
        contentType: response.headers["content-type"],
      }));
    });
    request.once("error", reject);
    request.setTimeout(2000, () => request.destroy(new Error("callback_response_timeout")));
  });
}

const received: Array<Record<string, string>> = [];
const callback = await createChatGptCallback(async (parameters) => {
  received.push(Object.fromEntries(parameters));
});
try {
  const malformed = await requestRawCallback(callback.redirectUri, "//[?code=CALLBACK_RAW_SECRET");
  const valid = await requestRawCallback(callback.redirectUri, "/auth/callback?state=expected-state&code=valid-code");
  process.stdout.write(JSON.stringify({ malformed, valid, received }));
} finally {
  callback.close();
}
