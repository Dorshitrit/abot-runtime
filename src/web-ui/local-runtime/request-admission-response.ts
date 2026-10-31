import { getSessionAdmissionErrorCode } from "../../runtime/request/session-busy.js";

const ADMISSION_MESSAGES = {
  session_busy: "This conversation already has an active request. Wait for it to finish or stop it before sending another message.",
  session_awaiting_approval: "This conversation has a request waiting for approval. Approve or cancel that request before sending another message.",
} as const;
type AdmissionFailure = { ok: false; error: keyof typeof ADMISSION_MESSAGES; message: string };

/** Wait for canonical admission before acknowledging a captured composer draft. */
export class RequestAdmissionResponse {
  private hasAdmissionDecision = false;
  private resolve!: (failure: AdmissionFailure | undefined) => void;
  readonly result = new Promise<AdmissionFailure | undefined>((resolve) => {
    this.resolve = resolve;
  });

  accept = (): void => {
    if (this.hasAdmissionDecision) return;
    this.hasAdmissionDecision = true;
    this.resolve(undefined);
  };

  rejectAdmission(error: unknown): boolean {
    if (this.hasAdmissionDecision) return false;
    const code = getSessionAdmissionErrorCode(error);
    if (!code) return false;
    this.hasAdmissionDecision = true;
    this.resolve({ ok: false, error: code, message: ADMISSION_MESSAGES[code] });
    return true;
  }
}
