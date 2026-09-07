import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const formModule = new URL(
  "../../web-ui/app/components/schedules/form.js",
  import.meta.url,
).href;

function submitIntervalEdit(
  anchorAt: string,
  initialWallTime: string,
  editedWallTime = initialWallTime,
) {
  const script = `
    import { scheduleFormInput, scheduleUpdateInput } from ${JSON.stringify(formModule)};
    const original = { kind: "interval", everyMs: 30000, anchorAt: ${JSON.stringify(anchorAt)} };
    const data = new FormData();
    data.set("kind", "interval");
    data.set("seconds", "30");
    data.set("anchorAt", ${JSON.stringify(initialWallTime)});
    const initial = scheduleFormInput(data, original);
    data.set("seconds", "90");
    data.set("anchorAt", ${JSON.stringify(editedWallTime)});
    const current = scheduleFormInput(data, original);
    console.log(JSON.stringify(scheduleUpdateInput(current, initial)));
  `;
  return JSON.parse(
    execFileSync(process.execPath, ["--input-type=module", "--eval", script], {
      env: { ...process.env, TZ: "America/New_York" },
      encoding: "utf8",
    }),
  ) as { schedule: { kind: string; everyMs: number; anchorAt?: string } };
}

describe("interval editor anchor preservation", () => {
  it.each([
    ["2026-09-06T14:10:32.456Z", "2026-09-06T10:10"],
    ["2026-11-01T06:30:32.456Z", "2026-11-01T01:30"],
    ["2026-11-01T01:30:32.456-05:00", "2026-11-01T01:30"],
  ])(
    "keeps exact untouched anchor %s when the interval duration changes",
    (anchorAt, wallTime) => {
      expect(submitIntervalEdit(anchorAt, wallTime)).toEqual({
        schedule: { kind: "interval", everyMs: 90_000, anchorAt },
      });
    },
  );

  it("uses the edited device-local time when the anchor actually changes", () => {
    expect(
      submitIntervalEdit(
        "2026-11-01T06:30:32.456Z",
        "2026-11-01T01:30",
        "2026-11-01T02:15",
      ),
    ).toEqual({
      schedule: {
        kind: "interval",
        everyMs: 90_000,
        anchorAt: "2026-11-01T07:15:00.000Z",
      },
    });
  });

  it("allows explicitly clearing the anchor to request a new automatic anchor", () => {
    expect(
      submitIntervalEdit("2026-11-01T06:30:32.456Z", "2026-11-01T01:30", ""),
    ).toEqual({
      schedule: { kind: "interval", everyMs: 90_000 },
    });
  });
});
