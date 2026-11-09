import { projectSparkHomeChange } from "../../runtime/local-host/client-spark-home-events.js";
import type { RealtimeClientHub } from "./realtime-hub.js";

export function createSparkHomeChangeNotifier(realtime: Pick<RealtimeClientHub, "broadcast">) {
  return (environmentId: string, value: unknown): void => {
    const change = projectSparkHomeChange(value);
    if (!change) return;
    try { realtime.broadcast({ type: "spark_home_changed", environmentId, ...change }); }
    catch { /* Views refetch the committed HOME on reconnect. */ }
  };
}
