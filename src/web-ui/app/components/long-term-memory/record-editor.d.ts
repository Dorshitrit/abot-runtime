import type { LongTermMemoryManagerView } from "./view-model.js";

export declare function renderMemoryRecordEditor(
  view: LongTermMemoryManagerView,
): string;
export declare function readMemoryEditorInput(root: ParentNode): Readonly<{
  content: string;
  tags: readonly string[];
}> | null;
