import { describe, expect, test } from "vitest";

import {
  isRuntimePathNamespaceCompatible,
  isRuntimePathWithinRoot,
  normalizeRuntimePathForScope,
} from "../capabilities/runtime-path-namespace.js";

describe("runtime path namespace syntax", () => {
  test.each([
    "C:/project/index.html",
    "c:\\project\\index.html",
    "C:index.html",
    "C:",
    "./C:/project/index.html",
    ".\\C:\\project\\index.html",
    "temp/../C:/project/index.html",
    "temp/../C:relative.txt",
    "temp\\..\\C:\\project\\index.html",
    "one/two/../.././C:/project/index.html",
    ".//C:/project/index.html",
    "\\\\server\\share\\index.html",
    "\\/server/share/index.html",
    "/\\server/share/index.html",
    "\\\\?\\C:\\project\\index.html",
    "\\\\.\\pipe\\runtime",
    "\\??\\C:\\project\\index.html",
  ])("rejects foreign Windows syntax %s on POSIX", (path) => {
    expect(isRuntimePathNamespaceCompatible(path, "linux")).toBe(false);
    expect(isRuntimePathNamespaceCompatible(path, "darwin")).toBe(false);
  });

  test.each([
    ".",
    "Project/index.html",
    "Project\\assets\\main.js",
    "workspace/reference.txt",
    "/mnt/c/fixture-target/Project/index.html",
    "//server/share/index.html",
    "notes:2026/report.txt",
    "K:notes/report.txt",
    "Project/C:/index.html",
    "temp/../Project/index.html",
    "one/two/../../Project/index.html",
    "temp/../notes:2026/report.txt",
    "temp/../server/share/index.html",
    "temp/../\\\\server\\share\\index.html",
    "temp\\..\\\\\\server\\share\\index.html",
    "./\\\\server\\share\\index.html",
    "/root/temp/../C:/literal-name.txt",
    "//server/share/temp/../index.html",
    "one/../../outside.txt",
    " trailing.txt ",
  ])("preserves supported POSIX syntax %s", (path) => {
    expect(isRuntimePathNamespaceCompatible(path, "linux")).toBe(true);
  });

  test.each([
    "C:/project/index.html",
    "c:\\project\\index.html",
    "\\\\server\\share\\index.html",
    "//server/share/index.html",
    "Project/index.html",
    "Project\\assets\\main.js",
    "workspace/reference.txt",
    ".",
    "temp/../\\\\server\\share\\index.html",
  ])("preserves qualified or relative native Windows syntax %s", (path) => {
    expect(isRuntimePathNamespaceCompatible(path, "win32")).toBe(true);
  });

  test.each([
    "C:relative.txt",
    "C:",
    "/current-drive/index.html",
    "\\current-drive\\index.html",
    "//server",
    "\\\\server",
    "./C:/project/index.html",
    "temp/../C:/project/index.html",
    "\\\\?\\C:\\project\\index.html",
    "\\\\?\\UNC\\server\\share\\index.html",
    "\\\\.\\pipe\\runtime",
    "//?/Volume{example}/index.html",
    "//./pipe/runtime",
  ])("rejects ambiguous native Windows syntax %s", (path) => {
    expect(isRuntimePathNamespaceCompatible(path, "win32")).toBe(false);
  });

  test.each([
    [
      "\\\\server\\share\\Project\\index.html",
      "//server/share/Project/index.html",
    ],
    ["//server/share/Project/index.html", "//server/share/Project/index.html"],
    ["C:\\Project\\index.html", "C:/Project/index.html"],
    ["Project\\assets\\main.js", "Project/assets/main.js"],
  ])(
    "normalizes Windows %s without losing its native root",
    (path, expected) => {
      expect(normalizeRuntimePathForScope(path, "win32")).toBe(expected);
    },
  );

  test("does not translate a POSIX mount into a drive path", () => {
    expect(
      normalizeRuntimePathForScope("/mnt/c/Project/index.html", "linux"),
    ).toBe("/mnt/c/Project/index.html");
    expect(
      normalizeRuntimePathForScope("//server/share/index.html", "linux"),
    ).toBe("/server/share/index.html");
  });
});

describe("native runtime root containment", () => {
  test.each([
    ["C:\\root\\Project\\index.html", "C:\\root", true],
    ["c:\\ROOT\\index.html", "C:\\root", true],
    ["C:\\root", "C:\\root", true],
    ["C:\\root-other\\index.html", "C:\\root", false],
    ["C:\\root\\..\\outside.txt", "C:\\root", false],
    ["D:\\other\\index.html", "C:\\root", false],
    ["\\\\server\\share\\root\\index.html", "\\\\server\\share\\root", true],
    ["\\\\server\\other-share\\index.html", "\\\\server\\share\\root", false],
    ["\\\\other-server\\share\\index.html", "\\\\server\\share\\root", false],
  ])("checks Windows %s within %s as %s", (target, root, expected) => {
    expect(isRuntimePathWithinRoot(target, root, "win32")).toBe(expected);
  });

  test.each([
    ["/root/Project/index.html", true],
    ["/root", true],
    ["/root-other/index.html", false],
    ["/root/../outside.txt", false],
    ["/Root/index.html", false],
  ])("checks POSIX %s within /root as %s", (target, expected) => {
    expect(isRuntimePathWithinRoot(target, "/root", "linux")).toBe(expected);
  });
});
