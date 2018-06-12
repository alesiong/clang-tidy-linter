'use strict';

import {
    DiagnosticCollection, TextDocument, Diagnostic, workspace, Disposable, languages,
    Range, DiagnosticSeverity
} from "vscode";
import { spawn } from 'child_process';
import { safeLoad } from 'js-yaml';

// TODO: change to options
const lintLanguages = new Set(['cpp', 'c']);

export default class ClangTidyProvider {
    private diagnosticCollection: DiagnosticCollection;
    // private command: Disposable;
    private static commandId = 'cpp.clangtidy.runCodeAction';

    constructor() {
        this.diagnosticCollection = languages.createDiagnosticCollection();
    }

    private doClangTidy(textDocument: TextDocument) {
        if (!lintLanguages.has(textDocument.languageId)) {
            return;
        }

        let decoded = '';
        const diagnostics: Diagnostic[] = [];


        const spawnOptions = workspace.rootPath ? { cwd: workspace.rootPath } : undefined;
        // FIXME: not work for windows
        const args = [textDocument.fileName,
            '--export-fixes=/dev/stdout'];

        // FIXME: add to config
        const childProcess = spawn('./clang-tidy', args, spawnOptions);
        if (childProcess.pid) {
            childProcess.stdout.on('data', (data) => {
                decoded += data;
            });

            childProcess.stdout.on('end', () => {
                const match = decoded.match(/(^\-\-\-(.*\n)*\.\.\.$)/gm);
                if (match && match[0]) {
                    const yaml = match[0];
                    const parsed: any = safeLoad(yaml);
                    parsed.Diagnostics.forEach((element: any) => {
                        const name: string = element.DiagnosticName;
                        const severity = name.endsWith('error') ?
                            DiagnosticSeverity.Error : DiagnosticSeverity.Warning;
                        const message: string = '[Clang Tidy] ' + element.Message;
                        const offset: number = element.FileOffset;
                        const startPosition = textDocument.positionAt(offset);

                        console.log(startPosition);
                        const range = new Range(startPosition, startPosition);
                        diagnostics.push(new Diagnostic(range, message, severity));
                    });
                    this.diagnosticCollection.set(textDocument.uri, diagnostics);
                }
            });
        }
    }

    public activate(subscriptions: Disposable[]) {
        // this.command = commands.registerCommand(ClangTidyProvider.commandId,
        // this.runCodeAction, this);
        subscriptions.push(this);

        workspace.onDidOpenTextDocument(this.doClangTidy, this, subscriptions);
        workspace.onDidSaveTextDocument(this.doClangTidy, this);
        workspace.onDidCloseTextDocument((textDocument) => {
            this.diagnosticCollection.delete(textDocument.uri);
        }, null, subscriptions);

        workspace.textDocuments.forEach(this.doClangTidy, this);
    }

    public dispose(): void {
        this.diagnosticCollection.clear();
        this.diagnosticCollection.dispose();
        // this.command.dispose();
    }
}