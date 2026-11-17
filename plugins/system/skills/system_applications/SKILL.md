# Applications

system_applications searches the selected target's declared application catalog sources. catalogComplete covers those sources within their observation budget, not every installed executable. Respect query limits and omissions; no match does not prove absence.

Use an application's id for system_launch. When executableResolution is present, its status describes only whether an executable path was resolved from that application's system metadata. Use path only for a resolved result on the same target. This observation does not supply arguments, prove successful launch or establish a visible window. Missing metadata, including from an older Companion or result byte limits, is unknown. output_budget_exceeded means optional executable detail was withheld; request a narrower catalog result if that detail is needed. Unresolved and ambiguous results do not authorize choosing a guessed path.

When needed, use system_command for bounded inspection of native resolution, registration or specific locations supported by evidence. Inspect a wrapper, script or link when its identity remains ambiguous. Avoid full-disk searches and repeated identity audits without a concrete missing fact.

system_launch revalidates the exact catalog identity and dispatches its native launch. macOS accepts raw arguments. Windows/Linux catalog launching does not define generic raw arguments; use the application's actual command interface through system_command when arguments are needed. An executable path is not a catalog id.

A launch receipt proves dispatch only. Inspect task-relevant evidence before claiming the requested effect. An already-running application's command line is not a list of its open documents or browser tabs; absence there does not prove that a requested URL failed. Do not relaunch solely because independent verification is unavailable.
