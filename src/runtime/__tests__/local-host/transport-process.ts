import { randomUUID } from "node:crypto";
import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

type ProcessMessage = Record<string, unknown>;

export class TransportProcess {
  readonly process: ChildProcess;
  readonly messages: ProcessMessage[] = [];
  private readonly listeners = new Set<() => void>();
  private stderr = "";

  constructor(
    directory: string,
    identity = "test-environment",
    worker = new URL("./transport-worker.ts", import.meta.url),
  ) {
    this.process = fork(fileURLToPath(worker), [directory, identity], {
      execArgv: ["--import", "tsx"],
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      serialization: "advanced",
    });
    this.process.stderr?.on("data", (data) => {
      this.stderr += String(data);
    });
    this.process.on("message", (message: ProcessMessage) => {
      this.messages.push(message);
      for (const listener of this.listeners) listener();
    });
    this.process.on("exit", () => {
      for (const listener of this.listeners) listener();
    });
  }

  async ready(): Promise<ProcessMessage> {
    return this.waitFor((message) => message.kind === "ready");
  }

  async call(method: string, ...args: unknown[]): Promise<unknown> {
    const id = randomUUID();
    this.process.send({ id, method, args });
    const response = await this.waitFor((message) => message.id === id);
    if (response.error) throw new Error(String(response.error));
    return response.result;
  }

  async kill(): Promise<void> {
    if (this.process.exitCode !== null || this.process.signalCode !== null)
      return;
    await new Promise<void>((resolve) => {
      this.process.once("exit", () => resolve());
      this.process.kill("SIGKILL");
    });
  }

  waitFor(
    predicate: (message: ProcessMessage) => boolean,
  ): Promise<ProcessMessage> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => finish(new Error(`Child timeout: ${this.stderr}`)),
        15_000,
      );
      const inspect = () => {
        const message = this.messages.find(predicate);
        if (message) {
          finish(undefined, message);
          return;
        }
        if (this.process.exitCode !== null || this.process.signalCode !== null)
          finish(new Error(`Child exited: ${this.stderr}`));
      };
      const finish = (error?: Error, message?: ProcessMessage) => {
        clearTimeout(timeout);
        this.listeners.delete(inspect);
        if (error) reject(error);
        else resolve(message!);
      };
      this.listeners.add(inspect);
      inspect();
    });
  }
}
