import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { copySessionProject } from "../../sessions/project-binding.js";
import type { RuntimeProject } from "./contracts.js";

/** One environment owner serializes updates; rename publishes a complete registry. */
export class FileProjectRepository {
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly filename: string) {}

  async list(): Promise<RuntimeProject[]> {
    try {
      const input: unknown = JSON.parse(await readFile(this.filename, "utf8"));
      if (!Array.isArray(input)) throw new Error("project_registry_invalid");
      return input.map((entry: RuntimeProject) => {
        const project = copySessionProject(entry);
        if (typeof entry.createdAt !== "string")
          throw new Error("project_registry_created_at_invalid");
        return { ...project, createdAt: entry.createdAt };
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  create(project: RuntimeProject): Promise<RuntimeProject> {
    const result = this.tail.then(async () => {
      const projects = await this.list();
      const existing = projects.find(
        (entry) => entry.directory === project.directory,
      );
      if (existing) return existing;
      await this.save([...projects, project]);
      return project;
    });
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async save(projects: readonly RuntimeProject[]): Promise<void> {
    await mkdir(dirname(this.filename), { recursive: true });
    const temporary = `${this.filename}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(projects, null, 2), "utf8");
      await rename(temporary, this.filename);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}
