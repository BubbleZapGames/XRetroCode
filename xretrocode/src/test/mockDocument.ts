import { Uri } from './vscode-mock';

/** A TextDocument stand-in with just what the R65 providers read. */
export function createMockDocument(content: string, path = '/test/file.r65'): any {
  const lines = content.split('\n');
  return {
    uri: Uri.file(path),
    getText: () => content,
    lineAt: (line: number) => ({ text: lines[line] }),
    lineCount: lines.length,
  };
}

/** Position of the first `marker` in `content`, plus `offset` characters. */
export function positionOf(content: string, marker: string, offset = 0): { line: number; character: number } {
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const at = lines[i].indexOf(marker);
    if (at >= 0) return { line: i, character: at + offset };
  }
  throw new Error(`marker not found: ${marker}`);
}

export const noCancel = { isCancellationRequested: false } as any;
