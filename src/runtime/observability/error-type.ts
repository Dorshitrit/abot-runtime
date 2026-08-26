export function classifyRuntimeErrorType(error: unknown): string {
  try {
    if (error instanceof TypeError) return "TypeError";
    if (error instanceof RangeError) return "RangeError";
    if (error instanceof SyntaxError) return "SyntaxError";
    if (error instanceof ReferenceError) return "ReferenceError";
    if (error instanceof URIError) return "URIError";
    if (error instanceof EvalError) return "EvalError";
    if (error instanceof Error) return "Error";
  } catch {
    return "unknown";
  }
  switch (typeof error) {
    case "string":
    case "number":
    case "boolean":
    case "bigint":
    case "symbol":
    case "undefined":
    case "function":
      return typeof error;
    default:
      return "unknown";
  }
}
