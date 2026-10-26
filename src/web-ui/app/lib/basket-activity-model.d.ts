export interface BasketActivity {
  phase: "discovery_found" | "search_started" | "search_completed" | "search_unavailable"
    | "read_started" | "read_completed" | "read_unavailable";
  label: string;
  status: "started" | "completed" | "unavailable" | "matched";
}

export declare function isBasketStatusEvent(event: unknown): boolean;
export declare function hasSupervisorBasketActivity(events: unknown[]): boolean;
export declare function projectBasketActivityEvent(event: unknown): BasketActivity | null;
