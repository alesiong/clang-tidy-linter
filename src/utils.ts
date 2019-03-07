import Uri from 'vscode-uri';
import { WorkspaceFolder } from "vscode-languageclient";

export function isValide(filePath: string, config: Configuration, workspaceFolders: WorkspaceFolder[]): boolean {
  if (config.excludes && config.excludes.some(s => filePath.includes(s))) {
    return false;
  }

  if (config.workspaceOnly && workspaceFolders &&
    !workspaceFolders.some(s => filePath.startsWith(Uri.parse(s.uri).fsPath))) {
    return false;
  }

  return true;
}
