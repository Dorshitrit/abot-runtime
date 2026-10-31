import { expect, test } from "vitest";
import type { ChatMessage } from "../../model-gateway/types.js";
import { ModelStepSteeringSupersededError } from "../model/model-step-steering.js";
import { REQUEST_STEERING_MESSAGE_KIND } from "../request/request-steering.js";
import {
  ADMISSION_MESSAGES,
  createAdmissionController,
  createAdmissionFixture,
  createAdmissionStage,
} from "./support/compaction-admission-fixture.js";

function steeringMessages(messages: readonly ChatMessage[]) {
  return messages.filter((message) => {
    try {
      return JSON.parse(message.content).kind === REQUEST_STEERING_MESSAGE_KIND;
    } catch {
      return false;
    }
  });
}

test("resumed Planner keeps exactly one caller steering envelope through compaction", async () => {
  const fixture = createAdmissionFixture({
    modelStep: "planner.decision",
    counts: [23_814, 1000],
  });
  fixture.steering.append({
    steerId: "redirect",
    text: "Save only the selected results.",
  });
  const active = createAdmissionStage("active_request", "compacted evidence");
  const controller = createAdmissionController([active]);
  const snapshot = fixture.steering.snapshot();
  await expect(
    fixture.invoker.invoke({
      modelStep: "planner.decision",
      messages: ADMISSION_MESSAGES,
      timeoutReason: "test_timeout",
      contextCompaction: controller,
      boundSteeringVersion: snapshot.version,
      callerSteering: snapshot,
      accept: (text) => text,
    }),
  ).resolves.toBe("ok");
  expect(active.commit).toHaveBeenCalledOnce();
  const envelopes = steeringMessages(
    fixture.invoke.mock.calls[0]![0].messages as ChatMessage[],
  );
  expect(envelopes).toHaveLength(1);
  expect(envelopes[0]!.role).toBe("user");
  expect(JSON.parse(envelopes[0]!.content)).toMatchObject({
    version: 1,
    authority: "user",
    updates: [{ sequence: 1, text: "Save only the selected results." }],
  });
});

test("new steering during resumed Planner admission prevents provider dispatch", async () => {
  const fixture = createAdmissionFixture({
    modelStep: "planner.decision",
    counts: [23_814, 1000],
  });
  fixture.steering.append({
    steerId: "first",
    text: "Change the remaining work.",
  });
  const active = createAdmissionStage("active_request", "compacted evidence");
  active.commit.mockImplementation(() => {
    fixture.steering.append({ steerId: "second", text: "Stop instead." });
  });
  const snapshot = fixture.steering.snapshot();
  await expect(
    fixture.invoker.invoke({
      modelStep: "planner.decision",
      messages: ADMISSION_MESSAGES,
      timeoutReason: "test_timeout",
      contextCompaction: createAdmissionController([active]),
      boundSteeringVersion: snapshot.version,
      callerSteering: snapshot,
      accept: (text) => text,
    }),
  ).rejects.toBeInstanceOf(ModelStepSteeringSupersededError);
  expect(fixture.invoke).not.toHaveBeenCalled();
});

test("an ordinary Planner still receives no global steering authority", async () => {
  const fixture = createAdmissionFixture({
    modelStep: "planner.decision",
    counts: [1000],
  });
  fixture.steering.append({ steerId: "first", text: "Do unrelated work." });
  await fixture.run(createAdmissionController([]));
  expect(
    steeringMessages(
      fixture.invoke.mock.calls[0]![0].messages as ChatMessage[],
    ),
  ).toEqual([]);
});
