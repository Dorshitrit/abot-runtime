import { createSessionBusyError } from "./session-busy.js";

/** Only the owning admission can recognize a claim by its object identity. */
export type SessionRequestAdmissionClaim = Readonly<{ sessionId: string }>;
type ActiveSessionClaim = { claim: SessionRequestAdmissionClaim; references: number };

/** Coordinates background admission with requests from every environment caller. */
export class SessionRequestAdmission {
  private readonly active = new Map<string, ActiveSessionClaim>();
  private readonly reserved = new Set<string>();
  private readonly automationReserved = new Set<string>();
  private readonly waiters = new Map<string, Set<() => void>>();
  private readonly idleWaiters = new Set<() => void>();
  private closed = false;
  private maintenance = false;

  constructor(
    private readonly isDeleted: (sessionId: string) => boolean,
    private readonly hasSavedWait?: (sessionId: string) => Promise<boolean>,
  ) {}

  async tryReserveAvailable(sessionId: string): Promise<(() => void) | null> {
    if (this.maintenance) return null;
    const release = this.tryReserve(sessionId);
    if (!release) return null;
    try {
      if (await this.hasSavedWait?.(sessionId)) {
        release();
        return null;
      }
      if (this.isUnavailableForReservation(sessionId)) {
        release();
        return null;
      }
      return release;
    } catch (error) {
      release();
      throw error;
    }
  }

  private isUnavailableForReservation(sessionId: string): boolean {
    if (this.maintenance) return true;
    if (this.closed) return true;
    return this.isDeleted(sessionId);
  }

  tryReserve(sessionId: string): (() => void) | null {
    if (this.closed) return null;
    if (this.isDeleted(sessionId)) return null;
    if (this.reserved.has(sessionId)) return null;
    if (this.isSessionActive(sessionId)) return null;
    this.reserved.add(sessionId);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.reserved.delete(sessionId);
      for (const notify of this.waiters.get(sessionId) ?? []) notify();
      this.waiters.delete(sessionId);
      this.notifyIdle();
    };
  }

  /** Automation Runs share idle accounting without impersonating a session. */
  tryReserveAutomation(automationId: string): (() => void) | null {
    if (this.maintenance) return null;
    if (this.closed) return null;
    if (this.automationReserved.has(automationId)) return null;
    this.automationReserved.add(automationId);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.automationReserved.delete(automationId);
      this.notifyIdle();
    };
  }

  async run<T>(
    sessionId: string,
    execute: (claim: SessionRequestAdmissionClaim) => Promise<T>,
    resume = false,
    existingClaim?: SessionRequestAdmissionClaim,
  ): Promise<T> {
    this.requireClaimOwnership(sessionId, existingClaim);
    while (this.isSessionReserved(sessionId)) {
      this.requireOpenAdmission();
      await this.waitForSessionReservation(sessionId);
    }
    this.requireOpenAdmission();
    if (this.isDeleted(sessionId)) throw new Error("session_deleted");
    const continuesClaim = existingClaim !== undefined;
    if (!continuesClaim && this.isSessionActive(sessionId))
      throw createSessionBusyError();
    const active = this.active.get(sessionId) ?? {
      claim: Object.freeze({ sessionId }), references: 0,
    };
    active.references += 1;
    // Claim before the first saved-state read yields to another caller.
    this.active.set(sessionId, active);
    try {
      if (this.shouldCheckSavedApproval(resume) && await this.hasSavedWait!(sessionId))
        throw new Error("session_awaiting_approval");
      this.requireOpenAdmission();
      if (this.isDeleted(sessionId)) throw new Error("session_deleted");
      return await execute(active.claim);
    } finally {
      active.references -= 1;
      if (active.references === 0) this.active.delete(sessionId);
      this.notifyIdle();
    }
  }

  private requireClaimOwnership(
    sessionId: string,
    claim: SessionRequestAdmissionClaim | undefined,
  ): void {
    if (!claim) return;
    if (this.active.get(sessionId)?.claim === claim) return;
    throw new Error("session_admission_claim_invalid");
  }

  private isSessionActive(sessionId: string): boolean {
    return this.active.has(sessionId);
  }

  private isSessionReserved(sessionId: string): boolean { return this.reserved.has(sessionId); }

  private shouldCheckSavedApproval(resume: boolean): boolean {
    if (resume) return false;
    return this.hasSavedWait !== undefined;
  }

  private waitForSessionReservation(sessionId: string): Promise<void> {
    return new Promise((resolve) => {
      const waiting = this.waiters.get(sessionId) ?? new Set();
      waiting.add(resolve);
      this.waiters.set(sessionId, waiting);
    });
  }

  /** Holds request intake while an already-idle owner performs explicit maintenance. */
  reserveMaintenance(): () => void {
    this.requireOpenAdmission();
    if (!this.isIdle()) throw new Error("runtime_maintenance_busy");
    this.maintenance = true;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.maintenance = false;
      this.notifyIdle();
    };
  }

  close(): void {
    this.closed = true;
    for (const waiting of this.waiters.values()) {
      for (const notify of waiting) notify();
    }
    this.waiters.clear();
  }

  whenIdle(): Promise<void> {
    if (this.isIdle()) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.add(resolve));
  }

  private requireOpenAdmission(): void {
    if (this.maintenance) throw new Error("runtime_maintenance_busy");
    if (this.closed) throw new Error("runtime_request_admission_closed");
  }

  isIdle(): boolean {
    if (this.maintenance) return false;
    if (this.active.size > 0) return false;
    if (this.reserved.size > 0) return false;
    return this.automationReserved.size === 0;
  }

  private notifyIdle(): void {
    if (!this.isIdle()) return;
    for (const notify of this.idleWaiters) notify();
    this.idleWaiters.clear();
  }
}
