export class DirectoryAuthorityError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly data?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "DirectoryAuthorityError";
  }
}
