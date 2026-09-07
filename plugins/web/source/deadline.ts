import {
  remainingTime as sharedRemainingTime,
  withinDeadline as sharedWithinDeadline,
} from "../../../src/shared/public-http/deadline.js";
import { rethrowWebPluginError } from "./errors.js";

export function remainingTime(deadline: number): number {
  try {
    return sharedRemainingTime(deadline);
  } catch (error) {
    return rethrowWebPluginError(error);
  }
}

export async function withinDeadline<T>(
  promise: Promise<T>,
  deadline: number,
  abortSignal?: AbortSignal,
): Promise<T> {
  try {
    return await sharedWithinDeadline(promise, deadline, abortSignal);
  } catch (error) {
    return rethrowWebPluginError(error);
  }
}
