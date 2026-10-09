/** Store-assigned identity. Build tooling and the packaged Companion share it. */
export const WINDOWS_COMPANION_STORE = Object.freeze({
  name: "ABot-AI.ABotAICompanion",
  publisher: "CN=5497306F-2434-4801-8B3F-4B721B2A2606",
  publisherDisplayName: "ABot-AI",
  displayName: "ABot AI Companion",
  familyName: "ABot-AI.ABotAICompanion_9b4v4r6by2e32",
  applicationId: "Companion",
  productId: "9PK2FDQQLQS9",
  protocol: "abot-companion:",
});

export const WINDOWS_COMPANION_AUMID =
  `${WINDOWS_COMPANION_STORE.familyName}!${WINDOWS_COMPANION_STORE.applicationId}`;
export const WINDOWS_COMPANION_STORE_URL =
  `https://apps.microsoft.com/detail/${WINDOWS_COMPANION_STORE.productId}`;
