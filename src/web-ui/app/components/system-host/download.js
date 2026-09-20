/** Save a setup file without retaining its authorization material. */
export function downloadHostSetup(
  receipt,
  {
    documentRoot = globalThis.document,
    urlApi = globalThis.URL,
    decode = globalThis.atob,
    createBlob = (parts, options) => new Blob(parts, options),
    defer = (callback) => setTimeout(callback, 1000),
  } = {},
) {
  if (!isSetupDownloadReceipt(receipt))
    throw new Error("Invalid setup download.");
  const bytes = Uint8Array.from(decode(receipt.contentBase64), (value) =>
    value.charCodeAt(0),
  );
  const url = urlApi.createObjectURL(
    createBlob([bytes], { type: receipt.mimeType }),
  );
  const link = documentRoot.createElement("a");
  try {
    link.href = url;
    link.download = receipt.filename;
    link.hidden = true;
    documentRoot.body.append(link);
    link.click();
  } finally {
    link.remove();
    defer(() => urlApi.revokeObjectURL(url));
  }
}
function isSetupDownloadReceipt(receipt) {
  if (typeof receipt?.filename !== "string") return false;
  if (!/^[a-z0-9][a-z0-9._-]{0,119}$/iu.test(receipt.filename)) return false;
  if (typeof receipt.mimeType !== "string") return false;
  if (typeof receipt.contentBase64 !== "string") return false;
  return receipt.contentBase64.length <= 8 * 1024 * 1024;
}
