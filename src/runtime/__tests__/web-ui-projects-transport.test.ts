import { describe, expect, test, vi } from "vitest";
import { createProjectRequests } from "../../web-ui/app/services/runtime-web-client/projects.js";
import { createRuntimeWebClient } from "../../web-ui/app/services/runtime-web-client.js";

function transport(supported = true) {
  let environmentId = "prod";
  const requestApi = vi.fn(async (_url: string, _options?: RequestInit) => ({}));
  const client = createProjectRequests({
    requestApi, getEnvironmentId: () => environmentId,
    getConfig: () => ({ supportsProjects: supported }),
  });
  return { client, requestApi, changeEnvironment: (value: string) => { environmentId = value; } };
}

describe("project client transport scope", () => {
  test("preserves explicit environment and encodes project identity in the session route", async () => {
    const f = transport();
    f.changeEnvironment("currently-selected");
    await f.client.createProjectSession("project/with spaces", "captured environment");
    expect(f.requestApi).toHaveBeenCalledWith(
      "/projects/project%2Fwith%20spaces/sessions?environment=captured%20environment",
      { method: "POST", body: "{}" },
    );
  });

  test("folder path, cursor and current environment survive transport as data", async () => {
    const f = transport();
    f.changeEnvironment("dev & review");
    await f.client.browseProjectFolders("/work/name/Desktop/#draft + files", "next+/=token");
    const url = new URL(f.requestApi.mock.calls[0]![0], "http://localhost");
    expect(url.pathname).toBe("/projects/folders");
    expect(url.searchParams.get("environment")).toBe("dev & review");
    expect(url.searchParams.get("path")).toBe("/work/name/Desktop/#draft + files");
    expect(url.searchParams.get("cursor")).toBe("next+/=token");
  });

  test("project creation sends only the selected name and folder", async () => {
    const f = transport();
    await f.client.createProject({ name: "Desktop work", directory: "/work/owner/Desktop" }, "prod");
    expect(f.requestApi.mock.calls[0]?.[1]?.method).toBe("POST");
    expect(JSON.parse(String(f.requestApi.mock.calls[0]?.[1]?.body))).toEqual({
      name: "Desktop work", directory: "/work/owner/Desktop",
    });
  });

  test("unsupported servers receive no project or folder request", async () => {
    const f = transport(false);
    expect(f.client.supportsProjects()).toBe(false);
    await expect(f.client.listProjects()).rejects.toThrow("unavailable");
    await expect(f.client.browseProjectFolders()).rejects.toThrow("unavailable");
    await expect(f.client.createProject({ name: "x", directory: "/work" })).rejects.toThrow("unavailable");
    await expect(f.client.createProjectSession("project-one")).rejects.toThrow("unavailable");
    expect(f.requestApi).not.toHaveBeenCalled();
  });

  test("the composed runtime client carries project routes through its configured API base", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ projects: [] })));
    const client = createRuntimeWebClient({
      getConfig: () => ({ supportsProjects: true, apiBasePath: "/custom-api" }),
      getEnvironmentId: () => "prod", fetchImpl, origin: "http://localhost",
    });
    await client.listProjects("dev");
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("/custom-api/projects?environment=dev");
    expect(fetchImpl.mock.calls[0]?.[1]?.body).toBeUndefined();
  });
});
