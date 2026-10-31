import { inspectRuntimeConfigFileWithMeta } from "../runtime/config/loader.js";

export function runtimeStartupDiagnostic(rootDir: string, configPath: string | undefined, error: unknown): string {
  try {
    const source = inspectRuntimeConfigFileWithMeta(rootDir, configPath);
    if (!source.exists) return "Complete model setup in the Web UI to start the model gateway.";
  } catch (inspectionError) {
    return inspectionError instanceof Error ? inspectionError.message : String(inspectionError);
  }
  return error instanceof Error ? error.message : String(error);
}
