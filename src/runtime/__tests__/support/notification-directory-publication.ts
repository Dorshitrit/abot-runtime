import { isAbsolute, relative, resolve, sep } from "node:path";
import { publishWindowsNotificationDirectory } from "../../../computer-access/companion/notification-directory-windows.js";
import {
  runNotificationProcess,
  type NotificationProcessInput,
  type NotificationProcessRunner,
} from "../../../computer-access/companion/notification-process.js";

function readWindowsDirectoryPublication(input: NotificationProcessInput) {
  if (process.platform !== "win32") return;
  if (input.file !== "powershell.exe") return;
  if (!input.input) return;
  let payload: unknown;
  try {
    payload = JSON.parse(input.input);
  } catch {
    return;
  }
  if (!payload || typeof payload !== "object") return;
  if (!("source" in payload) || !("destination" in payload)) return;
  if (typeof payload.source !== "string") return;
  if (typeof payload.destination !== "string") return;
  if (Object.keys(payload).length !== 2) return;
  return { source: payload.source, destination: payload.destination };
}

function isWithinNotificationFixture(
  rootDirectory: string,
  path: string,
): boolean {
  const pathFromRoot = relative(resolve(rootDirectory), resolve(path));
  if (!pathFromRoot || isAbsolute(pathFromRoot)) return false;
  if (pathFromRoot === "..") return false;
  return !pathFromRoot.startsWith(".." + sep);
}

/** Exercise Windows publication inside temporary fixtures while keeping OS registration mocked. */
export function withWindowsNotificationDirectoryPublication(
  run: NotificationProcessRunner,
  rootDirectory: string,
  beforePublication?: () => Promise<void>,
): NotificationProcessRunner {
  return async (input) => {
    const publication = readWindowsDirectoryPublication(input);
    if (!publication) return run(input);
    if (!isWithinNotificationFixture(rootDirectory, publication.source))
      throw new Error(
        "Notification publication source is outside its fixture.",
      );
    if (!isWithinNotificationFixture(rootDirectory, publication.destination))
      throw new Error(
        "Notification publication destination is outside its fixture.",
      );
    await beforePublication?.();
    await publishWindowsNotificationDirectory(
      publication.source,
      publication.destination,
      runNotificationProcess,
    );
    return "";
  };
}
