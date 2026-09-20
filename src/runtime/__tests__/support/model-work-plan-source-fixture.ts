import {
  createModelWorkPlanEventFixture,
  EVENT_WORK_PLAN,
} from "./model-work-plan-event-fixture.js";

import { createModelWorkPlanGraph } from "./model-work-plan-proposal-fixture.js";

export const WORK_PLAN_GRAPH = createModelWorkPlanGraph(EVENT_WORK_PLAN);

export async function createModelWorkPlanSourceFixture() {
  const fixture = await createModelWorkPlanEventFixture();
  const sourceResultRef = await fixture.returnSource();
  const summary = fixture.ledger
    .current()
    .state.results.find(
      (result) => result.resultRef === sourceResultRef,
    )!.summary;
  const current = () => {
    const head = fixture.ledger.current();
    return { head, call: head.state.calls[0]! };
  };
  return { ...fixture, current, sourceResultRef, summary };
}
