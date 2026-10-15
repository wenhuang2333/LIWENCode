import type { Tool } from '@liwencode/core';
import { FileStateTracker } from './file-state';
import { createReadTool, createWriteTool, createEditTool } from './fs-tools';
import { createGlobTool, createGrepTool } from './search-tools';
import { createBashTool } from './bash';

export { FileStateTracker } from './file-state';
export type { FileState } from './file-state';
export { createReadTool, createWriteTool, createEditTool } from './fs-tools';
export { createGlobTool, createGrepTool, loadGitignore, isIgnored } from './search-tools';
export type { IgnoreRules } from './search-tools';
export { createBashTool } from './bash';

export interface BuiltinToolsOptions {
  bash?: { defaultTimeoutMs?: number };
}

/** All six P0 built-in tools sharing one FileStateTracker. */
export function createBuiltinTools(opts: BuiltinToolsOptions = {}): { tools: Tool[]; fileState: FileStateTracker } {
  const fileState = new FileStateTracker();
  const tools: Tool[] = [
    createReadTool(fileState),
    createWriteTool(fileState),
    createEditTool(fileState),
    createGlobTool(),
    createGrepTool(),
    createBashTool(opts.bash),
  ];
  return { tools, fileState };
}
