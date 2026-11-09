import type { SparkHomeGenerationService } from "../spark-home/generation/contracts.js";
import type { LocalRuntimeOwnerActivity } from "./owner-activity.js";
import { isSparkHomeRunActive } from "../spark-home/generation/contracts.js";

/** Keep an accepted background HOME run under the same owner lease and maintenance fence. */
export function bindSparkHomeOwnerActivity(
  service: SparkHomeGenerationService | undefined,
  activity: LocalRuntimeOwnerActivity,
  publish: (event: unknown) => void,
): () => void {
  if (!service) return () => {};
  let heldRun: string | undefined;
  return service.subscribe(snapshot => {
    if (isSparkHomeRunActive(snapshot.status) && heldRun !== snapshot.runId) {
      heldRun = snapshot.runId;
      void activity.run(() => service.wait(snapshot.runId)).catch(() => {
        // A stopped owner cannot continue a HOME run after its lease retires.
        void service.stop();
      });
    }
    publish({ type: "spark-home.changed", runId: snapshot.runId, revision: snapshot.revision });
  });
}
