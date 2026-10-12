import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runInNewContext } from "node:vm";
import { expect, test } from "vitest";
import type { NativeAutostartOptions } from "../../computer-access/companion/autostart.js";
import { renderMacInstallLinkHandler } from "../../computer-access/companion/install-link-macos.js";

const options: NativeAutostartOptions = {
  platform: "darwin",
  homeDir: "/Users/Example Person",
  stateDir: "/Users/Example Person/.abot/host-companion",
  nodePath: '/Users/Example Person/Node "quoted"/node',
  cliPath: '/Users/Example Person/ABot\'s tools/"companion".mjs',
};
const link =
  "abot://install?kind=plugin&repo=https%3A%2F%2Fgithub.com%2Fowner%2Fplugin&ref=topic%2F%22quoted%22&path=plugins%2Fexample";
const expectedLaunch = {
  path: options.nodePath,
  args: [options.cliPath, "host", "open-link", link],
};
type RecordedTask = { launchPath?: string; arguments?: string[] };

test("Mac installation links expose the raw URL event handler and preserve separate quoted arguments", () => {
  const launches: unknown[] = [];
  const context = {
    ObjC: { import: () => {} },
    $: {
      NSTask: {
        alloc: {
          get init() {
            const task: RecordedTask = {};
            Object.defineProperty(task, "launch", {
              get() {
                launches.push({ path: task.launchPath, args: task.arguments });
              },
            });
            return task;
          },
        },
      },
    },
  };
  runInNewContext(renderMacInstallLinkHandler(options), context);
  const handler = (
    context as typeof context & {
      GURLGURL?: (url: string) => void;
    }
  ).GURLGURL;
  expect(handler).toBeTypeOf("function");
  handler!(link);
  expect(launches).toEqual([expectedLaunch]);
});

// Execute only an in-memory script with a fake task factory. Never register an
// app, launch Node/the Runtime, open a URL, or touch the user's Companion state.
const nativeDispatch = String.raw`
ObjC.import('OSAKit');
function run(argv) {
  var language = $.OSALanguage.languageForName('JavaScript');
  var script = $.OSAScript.alloc.initWithSourceLanguage(argv[0], language);
  var event = $.NSAppleEventDescriptor.appleEventWithEventClassEventIDTargetDescriptorReturnIDTransactionID(
    0x4755524c, 0x4755524c, $.NSAppleEventDescriptor.nullDescriptor, -1, 0);
  event.setParamDescriptorForKeyword($.NSAppleEventDescriptor.descriptorWithString(argv[1]), 0x2d2d2d2d);
  var error = Ref();
  var result = script.executeAppleEventError(event, error);
  var value = result && !result.isNil() ? ObjC.unwrap(result.stringValue) : null;
  var eventError = error[0] ? ObjC.deepUnwrap(error[0]) : null;
  return JSON.stringify({value: value || null, error: eventError || null});
}
`;

test.skipIf(process.platform !== "darwin")(
  "native JXA dispatches the GURL/GURL AppleEvent to the generated installation-link handler",
  async () => {
    const generated = renderMacInstallLinkHandler(options);
    const taskFactory = "$.NSTask.alloc.init";
    // Fail closed if the production launcher changes: no real NSTask is ever
    // allowed into this native diagnostic, even after a renderer refactor.
    expect(generated.split(taskFactory)).toHaveLength(2);
    expect(generated.split("task.launch;")).toHaveLength(2);
    const instrumented = generated
      .replace(taskFactory, "recordedTask()")
      // Observe this event's result directly. Calling the script's run handler
      // afterwards would re-evaluate its global initializers and erase records.
      .replace("task.launch;", "task.launch; return JSON.stringify(launches);");
    expect(instrumented).not.toContain("NSTask");
    const source = `
var launches = [];
function recordedTask() {
  var task = {};
  Object.defineProperty(task, 'launch', {get: function() {
    launches.push({path: task.launchPath, args: task.arguments});
  }});
  return task;
}
${instrumented}
`;
    const execute = promisify(execFile);
    async function dispatch(script: string) {
      const { stdout } = await execute(
        "/usr/bin/osascript",
        ["-l", "JavaScript", "-e", nativeDispatch, script, link],
        { timeout: 20_000, maxBuffer: 16_384 },
      );
      return JSON.parse(stdout.trim()) as {
        value: string | null;
        error: unknown;
      };
    }
    // The old handler is an explicit negative control; no repository source is
    // modified to prove that merely registering the URL app is insufficient.
    expect(generated.split("function GURLGURL(url)")).toHaveLength(2);
    const legacy = await dispatch(
      source.replace("function GURLGURL(url)", "function openLocation(url)"),
    );
    expect(legacy.value).toBeNull();
    const current = await dispatch(source);
    expect(current.error).toBeNull();
    expect(JSON.parse(current.value ?? "null")).toEqual([expectedLaunch]);
  },
  30_000,
);
