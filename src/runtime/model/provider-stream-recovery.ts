import { isProviderStreamDisconnectionError } from "../../model-gateway/protocol/provider-stream-disconnection.js";
import { traceDebug } from "../observability/debug-logger.js";

type ProviderStreamRecoveryInput<T> = Readonly<{
  invoke(): Promise<T>;
  signal: AbortSignal;
  assertCurrent(): void;
  onRetry(): void;
  identity: Readonly<{ requestId: string; modelStep: string; invocationId: string }>;
}>;

function waitForProviderRetry(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, 250);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** One replacement provider call per logical model step, sharing its original deadline. */
export class ProviderStreamRecovery {
  private attempted = false;

  async invoke<T>(input: ProviderStreamRecoveryInput<T>): Promise<T> {
    input.signal.throwIfAborted();
    try {
      return await input.invoke();
    } catch (error) {
      input.signal.throwIfAborted();
      if (!this.canRetryProviderStream(error)) throw error;
      input.assertCurrent();
      this.attempted = true;
      input.onRetry();
      traceDebug("runtime.model", "provider_stream.retry_started", input.identity);
    }
    return this.retry(input);
  }

  private canRetryProviderStream(error: unknown): boolean {
    if (this.attempted) return false;
    return isProviderStreamDisconnectionError(error);
  }

  private async retry<T>(input: ProviderStreamRecoveryInput<T>): Promise<T> {
    try {
      await waitForProviderRetry(input.signal);
      input.signal.throwIfAborted();
      input.assertCurrent();
      const result = await input.invoke();
      input.signal.throwIfAborted();
      traceDebug("runtime.model", "provider_stream.recovered", input.identity);
      return result;
    } catch (error) {
      traceDebug("runtime.model", "provider_stream.retry_failed", input.identity);
      input.signal.throwIfAborted();
      throw error;
    }
  }
}
