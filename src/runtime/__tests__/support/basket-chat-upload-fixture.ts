import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { createFileAttachmentStore, type RuntimeAttachmentReference } from "../../attachments/store.js";
import { createInformationBasketService } from "../../information-basket/service.js";
import { createLocalInformationBasketClient } from "../../local-host/client-information-basket.js";
import { dispatchLocalServiceCall } from "../../local-host/app-service-dispatch.js";
import { LocalAttachmentRoutes } from "../../../web-ui/local-runtime/attachment-routes.js";
import type { RuntimeEnvironment } from "../../../web-ui/local-runtime/contracts.js";
import type { RuntimeEnvironmentServices } from "../../composition.js";
import { createBasketFixture } from "./information-basket-fixture.js";

export async function createBasketChatUploadFixture(...args: Parameters<typeof createBasketFixture>) {
  const base = await createBasketFixture(...args);
  await base.service.stop();
  const attachments = createFileAttachmentStore({ attachmentsDir: join(base.root, "attachments") });
  const service = createInformationBasketService({ config: base.config, models: { embed: base.embed }, attachments });
  await service.start();
  const owner = { informationBasket: service, attachments } as RuntimeEnvironmentServices;
  const client = createLocalInformationBasketClient((method, inputs) => dispatchLocalServiceCall(owner, method, inputs));
  const environment = { services: { attachments, informationBasket: client.service } } as unknown as RuntimeEnvironment;
  const routes = new LocalAttachmentRoutes();
  const server = createServer((req, res) => {
    void routes.upload(req, res, environment).catch(() => { res.statusCode = 500; res.end(); });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/upload`;
  return {
    ...base, service, attachments, client,
    async setUploads(indexChatUploads: boolean, embeddingProfileId: string | null = null) {
      const { settings } = await service.list();
      return service.updateSettings({ ...settings, expectedRevision: settings.revision, indexChatUploads, embeddingProfileId });
    },
    async upload(name = "notes.txt", mimeType = "text/plain", headers: Record<string, string> = {}, requestBody: string | ArrayBuffer = "apple uploaded source") {
      const response = await fetch(`${url}?sessionId=chat-one&name=${encodeURIComponent(name)}`, {
        method: "POST", headers: { "content-type": mimeType, ...headers }, body: requestBody,
      });
      const body = response.status === 200 ? await response.json() as { ok: true; attachment: RuntimeAttachmentReference } : null;
      return { status: response.status, body };
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      client.close();
      await service.stop();
    },
  };
}
