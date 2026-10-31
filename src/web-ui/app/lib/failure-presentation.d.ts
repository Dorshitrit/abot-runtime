export declare function isTransportFailureText(value: unknown): boolean;
export declare function presentFailureText(value: unknown): string;
export declare function failureResponseText(terminal?: {
  error?: unknown;
  details?: { stoppedResponse?: unknown };
} | null): string;
