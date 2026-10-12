/** Installation-owned UI state. These records never become model context. */
export type ClientPreferences = Record<string, string>;
export type ClientState = {
  version: 1;
  revision: number;
  introductionSeen: boolean;
  preferences: ClientPreferences;
  queue: string;
};

export function emptyClientState(): ClientState {
  return { version: 1, revision: 0, introductionSeen: false,
    preferences: { "abot-web.lastToolPermissionMode": "ask" }, queue: "" };
}

export class ClientStateError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) {
    super(message);
  }
}
