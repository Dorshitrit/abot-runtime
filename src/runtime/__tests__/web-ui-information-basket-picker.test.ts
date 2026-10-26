import { expect, test, vi } from "vitest";
// @ts-expect-error Browser-only module.
import { createBasketPickerController } from "../../web-ui/app/controllers/information-basket-picker-controller.js";
import type { BasketFilePage } from "../information-basket/contracts.js";

type Entry = BasketFilePage["entries"][number];
const file = (name: string, supported = true): Entry => ({ name, path: `/documents/${name}`, kind: "file", supported });
function page(entries: readonly Entry[], nextCursor: string | null = null): BasketFilePage {
  return { directory: "/documents", parent: "/", roots: [], entries, nextCursor, hostPlatform: "linux" };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { resolve, promise };
}
function fixture(initial: BasketFilePage, limit = 200) {
  let environment = "dev";
  const client = { browseInformationBasket: vi.fn(async () => initial) };
  const register = vi.fn(async () => true);
  const picker = createBasketPickerController({ client, register, render: vi.fn(),
    getEnvironmentId: () => environment, getSelectionLimit: () => limit });
  return { client, register, picker, setEnvironment(value: string) { environment = value; picker.environmentChanged(); } };
}

test("select all reads the entire current folder before applying supported file selection", async () => {
  const first = Array.from({ length: 100 }, (_, index) => file(`${index}.md`));
  const extra = file("last.pdf");
  const folder: Entry = { name: "nested", path: "/documents/nested", kind: "directory", supported: true };
  const f = fixture(page(first, "next"));
  await f.picker.open();
  f.picker.select(first[0]!.path);
  const last = deferred<BasketFilePage>();
  f.client.browseInformationBasket.mockResolvedValueOnce(page(first, "next")).mockReturnValueOnce(last.promise);
  const selecting = f.picker.selectAll();
  await vi.waitFor(() => expect(f.client.browseInformationBasket).toHaveBeenCalledTimes(3));
  expect(f.picker.snapshot()).toMatchObject({ loading: true, selectingAll: true, selectedPaths: [first[0]!.path] });
  expect(f.register).not.toHaveBeenCalled();
  last.resolve(page([extra, file("archive.zip", false), folder]));
  expect(await selecting).toBe(true);
  const paths = [...first.map((entry) => entry.path), extra.path];
  expect(f.picker.snapshot()).toMatchObject({ loading: false, selectingAll: false, selectedPaths: paths });
  expect(f.picker.snapshot().page.nextCursor).toBeNull();
  expect(f.client.browseInformationBasket.mock.calls).toEqual([
    ["", "dev", ""], ["/documents", "dev", ""], ["/documents", "dev", "next"],
  ]);
  expect(f.register).not.toHaveBeenCalled();
  expect(await f.picker.submit()).toBe(true);
  expect(f.register).toHaveBeenCalledExactlyOnceWith(paths, "");
});

test("failed later pages retain the previous selection and expose the listing failure", async () => {
  const existing = file("existing.md");
  const initial = page([existing], "next");
  const f = fixture(initial);
  await f.picker.open(); f.picker.select(existing.path);
  f.client.browseInformationBasket.mockResolvedValueOnce(page([file("new.md")], "next"))
    .mockRejectedValueOnce(new Error("Folder is no longer readable"));
  expect(await f.picker.selectAll()).toBe(false);
  expect(f.picker.snapshot()).toMatchObject({ loading: false, selectingAll: false,
    selectedPaths: [existing.path], page: initial, error: "Folder is no longer readable" });
  expect(f.register).not.toHaveBeenCalled();
  f.picker.clearSelection();
  expect(f.picker.snapshot()).toMatchObject({ selectedPaths: [], error: "" });
});

test("select all accepts 200 supported files and rejects larger folders without partial selection", async () => {
  const entries = Array.from({ length: 201 }, (_, index) => file(`${index}.md`));
  const first = page(entries.slice(0, 100), "next");
  const f = fixture(first);
  await f.picker.open(); f.picker.select(entries[0]!.path);
  f.client.browseInformationBasket.mockResolvedValueOnce(first).mockResolvedValueOnce(page(entries.slice(100)));
  expect(await f.picker.selectAll()).toBe(false);
  expect(f.picker.snapshot().selectedPaths).toEqual([entries[0]!.path]);
  expect(f.picker.snapshot().error).toContain("200");
  expect(f.register).not.toHaveBeenCalled();
  f.client.browseInformationBasket.mockResolvedValueOnce(first).mockResolvedValueOnce(page(entries.slice(100, 200)));
  expect(await f.picker.selectAll()).toBe(true);
  expect(f.picker.snapshot().selectedPaths).toHaveLength(200);
  expect(f.picker.snapshot().error).toBe("");
});

test("manual selection and submission honor the declared selection limit", async () => {
  const a = file("a.md"), b = file("b.md"), c = file("c.md");
  const f = fixture(page([a, b, c]), 2);
  await f.picker.open();
  f.picker.select(a.path); f.picker.select(b.path); f.picker.select(c.path);
  expect(f.picker.snapshot().selectedPaths).toEqual([a.path, b.path]);
  expect(f.picker.snapshot().error).toContain("2");
  expect(await f.picker.submit([a.path, b.path, c.path])).toBe(false);
  expect(f.register).not.toHaveBeenCalled();
  f.picker.select(a.path); f.picker.select(c.path);
  expect(f.picker.snapshot()).toMatchObject({ selectedPaths: [b.path, c.path], error: "" });
});

test.each(["close", "environment", "folder"])("%s change invalidates select-all reads and further pages", async (change) => {
  const f = fixture(page([file("old.md")], "next"));
  await f.picker.open();
  const pending = deferred<BasketFilePage>();
  f.client.browseInformationBasket.mockReturnValueOnce(pending.promise);
  const selecting = f.picker.selectAll();
  if (change === "close") f.picker.close();
  if (change === "environment") f.setEnvironment("prod");
  if (change === "folder") {
    f.client.browseInformationBasket.mockResolvedValueOnce({ ...page([]), directory: "/other" });
    await f.picker.browse("/other");
  }
  const expectedCalls = f.client.browseInformationBasket.mock.calls.length;
  pending.resolve(page([file("late.md")], "next"));
  expect(await selecting).toBe(false);
  expect(f.client.browseInformationBasket).toHaveBeenCalledTimes(expectedCalls);
  expect(f.picker.snapshot()).toMatchObject({ loading: false, selectingAll: false, selectedPaths: [] });
  expect(f.picker.snapshot().page?.directory ?? null).toBe(change === "folder" ? "/other" : null);
});

test("pending links stay single-selection and never begin select-all discovery", async () => {
  const a = file("a.md"), b = file("b.md");
  const f = fixture(page([a, b]));
  await f.picker.open({ sourceId: "pending-1", displayName: "original.md" });
  expect(await f.picker.selectAll()).toBe(false);
  expect(f.client.browseInformationBasket).toHaveBeenCalledOnce();
  f.picker.select(a.path); f.picker.select(b.path); f.picker.clearSelection();
  expect(f.picker.snapshot().selectedPaths).toEqual([b.path]);
  expect(await f.picker.submit()).toBe(true);
  expect(f.register).toHaveBeenCalledExactlyOnceWith([b.path], "pending-1");
});

test("changed directory or repeated page cursor fails without committing new selection", async () => {
  const original = file("original.md");
  const f = fixture(page([original]));
  await f.picker.open(); f.picker.select(original.path);
  f.client.browseInformationBasket.mockResolvedValueOnce({ ...page([file("other.md")]), directory: "/other" });
  expect(await f.picker.selectAll()).toBe(false);
  expect(f.picker.snapshot().selectedPaths).toEqual([original.path]);
  f.client.browseInformationBasket.mockResolvedValueOnce(page([file("a.md")], "same"))
    .mockResolvedValueOnce(page([file("b.md")], "same"));
  expect(await f.picker.selectAll()).toBe(false);
  expect(f.picker.snapshot().selectedPaths).toEqual([original.path]);
  expect(f.picker.snapshot().error).not.toBe("");
});
