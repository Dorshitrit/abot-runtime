import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { RuntimeProject, RuntimeProjectCatalog } from "./contracts.js";
import { readProjectCatalog } from "./registry-format.js";

/** One environment owner serializes updates; rename publishes a complete catalog. */
export class FileProjectRepository {
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly filename: string) {}

  async catalog(): Promise<RuntimeProjectCatalog> {
    try {
      return readProjectCatalog(JSON.parse(await readFile(this.filename, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { projects: [], deletedProjectIds: [] };
      throw error;
    }
  }

  async list(): Promise<readonly RuntimeProject[]> {
    return (await this.catalog()).projects;
  }

  create(project: RuntimeProject): Promise<RuntimeProject> {
    return this.mutate(async (catalog) => {
      const existing = catalog.projects.find(
        (entry) => entry.directory === project.directory,
      );
      if (existing) return existing;
      await this.save({ ...catalog, projects: [...catalog.projects, project] });
      return project;
    });
  }

  delete(projectId: string): Promise<void> {
    return this.mutate(async (catalog) => {
      if (catalog.deletedProjectIds.includes(projectId)) return;
      await this.save({
        projects: catalog.projects.filter((project) => project.id !== projectId),
        deletedProjectIds: [...catalog.deletedProjectIds, projectId],
      });
    });
  }

  private mutate<T>(apply: (catalog: RuntimeProjectCatalog) => Promise<T>): Promise<T> {
    const result = this.tail.then(async () => apply(await this.catalog()));
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async save(catalog: RuntimeProjectCatalog): Promise<void> {
    await mkdir(dirname(this.filename), { recursive: true });
    const temporary = `${this.filename}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify({ version: 1, ...catalog }, null, 2), "utf8");
      await rename(temporary, this.filename);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}
