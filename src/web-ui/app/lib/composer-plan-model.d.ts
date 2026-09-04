export type ComposerPlanItem = {
  id: string;
  title: string;
  status: "pending" | "active" | "done" | "blocked" | "superseded";
  order: number;
};

export type ComposerPlanModel = {
  requestId: string;
  turnKey: string;
  summary: string;
  preview: string;
  previewStatus: "pending" | "active" | "done";
  items: ComposerPlanItem[];
  total: number;
  completed: number;
  hasSignal: boolean;
};

export type ComposerPlanMessage = {
  id?: unknown;
  role: string;
  requestId?: unknown;
};

export declare function buildComposerPlanModel(options?: {
  messages?: ComposerPlanMessage[];
  activeRequestId?: unknown;
  getActivityForMessage?(message: ComposerPlanMessage): {
    taskProgress?: unknown;
  };
}): ComposerPlanModel | null;
