import {
  observeSystemHost,
  readSystemHostFacts,
} from "../computer-access/host-observation.js";

function hasExplicitLoopbackPublishTrust(): boolean {
  return process.env.ABOT_WEB_TRUST_LOOPBACK_PUBLISH === "1";
}

/** Only the deployment owner can assert that Docker publishes exclusively on loopback. */
export function allowsPublishedLoopbackAuthority(listenHost: string): boolean {
  if (!hasExplicitLoopbackPublishTrust()) return false;
  const wildcardListener = ["0.0.0.0", "::", "[::]", "*"].includes(
    listenHost.trim().toLowerCase(),
  );
  if (!wildcardListener) return false;
  const observed = observeSystemHost(readSystemHostFacts());
  return observed.environment === "container";
}
