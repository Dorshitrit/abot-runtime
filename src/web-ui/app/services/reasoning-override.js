/** Save only the selected profile flag through the revision-checked config service. */
export async function enableModelReasoning(client, profileId, environmentId) {
  const payload = await client.loadConfigDashboard(environmentId, { settled: true });
  const file = payload?.dashboard?.files?.models?.find((item) => item.id === profileId && item.registered === true);
  if (!file || file.invalidJson || !file.revision)
    throw new Error("This model cannot be updated here. Open Models to review its configuration.");
  if (file.config?.supportsThinking === true) return;
  await client.saveConfigFile({
    environmentId, kind: "model", id: profileId,
    config: { ...file.config, supportsThinking: true }, expectedRevision: file.revision,
  });
}
