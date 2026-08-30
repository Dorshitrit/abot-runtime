export type RuntimeConfigValidationOptions = Readonly<{
  /** Inspection-only mode. Canonical runtime loading always omits this flag. */
  allowIncompleteSetup?: boolean;
}>;

export class RuntimeConfigValidationError extends Error {
  readonly configPath: string;
  readonly issues: string[];

  constructor(configPath: string, issues: string[]) {
    super(
      [
        `Invalid runtime config at ${configPath}:`,
        ...issues.map((issue) => `- ${issue}`),
      ].join("\n"),
    );
    this.name = "RuntimeConfigValidationError";
    this.configPath = configPath;
    this.issues = issues;
  }
}
