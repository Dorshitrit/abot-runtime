/** Extraction failures carry stable format codes, never filesystem paths. */
export class DocumentTextError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "DocumentTextError";
  }
}
export function failDocumentText(code: string, message: string): never {
  throw new DocumentTextError(code, message);
}
