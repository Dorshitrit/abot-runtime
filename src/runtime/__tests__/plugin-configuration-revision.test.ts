import { createHash } from "node:crypto";
import { expect, test, vi } from "vitest";
import { projectPluginConfiguration } from "../../web-ui/plugin-configuration-view.js";
import { readPluginConfigurationStore } from "../plugins/configuration-store.js";
import {
  configurableManifest,
  configurationRequest,
  pluginConfigurationFixture,
} from "./support/plugin-configuration-fixture.js";

test("browser revisions cannot be reproduced from known store bytes and secret guesses", async () => {
  const f = await pluginConfigurationFixture();
  await f.save({}, { token: { action: "set", value: "1234" } });
  const store = readPluginConfigurationStore(f.rootDir);
  const declaration = configurableManifest().extensions["ai.abot.runtime"];
  const guessedStoreRevision = createHash("sha256")
    .update(`present:${store.raw}`)
    .digest("hex");
  const unkeyedVerifier = createHash("sha256")
    .update(
      JSON.stringify([
        "community-example",
        declaration.settings.defaults,
        declaration.secrets,
        guessedStoreRevision,
      ]),
    )
    .digest("hex");
  const response = await configurationRequest(f.routes, "GET");
  expect(response.status).toBe(200);
  expect(response.payload.configuration.revision).not.toBe(unkeyedVerifier);
  expect(response.payload.configuration.revision).not.toBe(
    guessedStoreRevision,
  );
  expect(f.view().revision).toBe(response.payload.configuration.revision);
});

test("revision issuers keep stable tokens locally and use independent private keys", async () => {
  const f = await pluginConfigurationFixture();
  await f.save({}, { token: { action: "set", value: "short" } });
  const store = readPluginConfigurationStore(f.rootDir);
  const declaration = configurableManifest().extensions["ai.abot.runtime"];
  const before = projectPluginConfiguration(
    "community-example",
    declaration,
    store,
  );
  vi.resetModules();
  const freshIssuer = await import("../../web-ui/plugin-configuration-view.js");
  const after = freshIssuer.projectPluginConfiguration(
    "community-example",
    declaration,
    store,
  );
  expect(after.revision).not.toBe(before.revision);
  expect(
    freshIssuer.projectPluginConfiguration(
      "community-example",
      declaration,
      store,
    ).revision,
  ).toBe(after.revision);
  expect(after.settings).toEqual(before.settings);
  expect(after.secrets).toEqual(before.secrets);
});
