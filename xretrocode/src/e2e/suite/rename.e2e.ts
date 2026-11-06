// Rename Symbol (F2) through VS Code's own rename commands, on the fixture
// rename-demo.r65 and the assembly file that defines its extern fn.
import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import { WORKSPACE, sleep } from './helpers';

const SOURCE = vscode.Uri.file(path.join(WORKSPACE, 'rename-demo.r65'));

/** Position of the first `marker` in the fixture, plus `offset` characters. */
function positionOf(doc: vscode.TextDocument, marker: string, offset = 0): vscode.Position {
  const at = doc.getText().indexOf(marker);
  assert.ok(at >= 0, `no ${marker} in the fixture`);
  return doc.positionAt(at + offset);
}

/** The edit as `file:line:col` per change, sorted. */
function describeEdit(edit: vscode.WorkspaceEdit): string[] {
  return edit.entries()
    .flatMap(([uri, edits]) => edits.map(e => `${path.basename(uri.fsPath)}:${e.range.start.line}:${e.range.start.character}:${e.newText}`))
    .sort();
}

/** The rename's edit once the symbol index has caught up with the workspace (it indexes on activation). */
async function renameEdit(doc: vscode.TextDocument, at: vscode.Position, newName: string): Promise<vscode.WorkspaceEdit> {
  const end = Date.now() + 10_000;
  for (;;) {
    try {
      const edit = await vscode.commands.executeCommand<vscode.WorkspaceEdit>(
        'vscode.executeDocumentRenameProvider', doc.uri, at, newName
      );
      if (edit && edit.size > 0) return edit;
    } catch (e) {
      if (Date.now() > end) throw e;
    }
    if (Date.now() > end) assert.fail('the rename provider never answered');
    await sleep(200);
  }
}

describe('Rename Symbol', () => {
  let doc: vscode.TextDocument;

  before(async () => {
    doc = await vscode.workspace.openTextDocument(SOURCE);
    await vscode.window.showTextDocument(doc);
  });

  it('renames a field in its declaration, a struct literal and accesses', async () => {
    const edit = await renameEdit(doc, positionOf(doc, 'y: u8'), 'row');
    assert.deepStrictEqual(describeEdit(edit), [
      'rename-demo.r65:14:35:row',
      'rename-demo.r65:16:21:row',
      'rename-demo.r65:4:24:row',
    ]);
  });

  it('renames an extern fn in R65, in asm! strings and at its assembly label', async () => {
    const edit = await renameEdit(doc, positionOf(doc, 'rd_play(rd_count'), 'rd_sound');
    assert.deepStrictEqual(describeEdit(edit), [
      'rename-demo.r65:16:4:rd_sound',
      'rename-demo.r65:2:10:rd_sound',
      'rename-demo.r65:9:18:rd_sound',
      'rename-demo.s:1:0:rd_sound',
    ]);
  });

  it('renames a local within its fn', async () => {
    const edit = await renameEdit(doc, positionOf(doc, 'rd_count ='), 'rd_origin');
    assert.deepStrictEqual(describeEdit(edit), [
      'rename-demo.r65:14:8:rd_origin',
      'rename-demo.r65:16:12:rd_origin',
    ]);
  });

  it('refuses to rename a keyword', async () => {
    await assert.rejects(
      async () => vscode.commands.executeCommand('vscode.prepareRename', doc.uri, positionOf(doc, 'let')),
      /keyword/
    );
  });
});
