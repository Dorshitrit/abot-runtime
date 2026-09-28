/** Pure Swift permission gate; injected effects keep native tests free of TCC requests. */
export const MACOS_OBSERVATION_PERMISSION_SCRIPT = String.raw`
func waitForMacObservationPermission(
  isTrusted: () -> Bool,
  requestPermission: () -> Void,
  now: () -> Double,
  wait: (Double) -> Void,
  reportRequired: () -> Void,
  reportTimeout: () -> Void
) -> Bool {
  if isTrusted() { return true }
  let deadline = now() + 120
  requestPermission()
  reportRequired()
  while true {
    let remaining = deadline - now()
    let permissionWaitExpired = remaining <= 0
    if permissionWaitExpired {
      reportTimeout()
      return false
    }
    wait(min(2, remaining))
    if isTrusted() { return true }
  }
}
`;
