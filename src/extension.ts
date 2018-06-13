'use strict';
// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below

import ClangTidyProvider from './features/ClangTidyProvider';
import { ExtensionContext, languages } from 'vscode';

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
export function activate(context: ExtensionContext) {
    const linter = new ClangTidyProvider();
    linter.activate(context.subscriptions);
    languages.registerCodeActionsProvider({ scheme: 'file', language: 'cpp' }, linter);
}

// this method is called when your extension is deactivated
export function deactivate() {
}