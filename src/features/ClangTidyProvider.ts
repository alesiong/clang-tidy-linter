'use strict';

import {
    DiagnosticCollection, TextDocument, Diagnostic, workspace, Disposable, languages,
    Range, DiagnosticSeverity, commands, CodeActionContext, CancellationToken, Command
} from "vscode";
import { spawn } from 'child_process';
import { safeLoad } from 'js-yaml';

export default class ClangTidyProvider {
    private diagnosticCollection: DiagnosticCollection;
    private command: Disposable;
    private static commandId = 'clangTidy.runCodeAction';

    constructor() {
        this.diagnosticCollection = languages.createDiagnosticCollection();
        this.command = commands.registerCommand(ClangTidyProvider.commandId,
            this.runCodeAction, this);
    }

    private getConfiguration(): Configuration {
        return workspace.getConfiguration('clangTidy') as any;
    }
    private doClangTidy(textDocument: TextDocument) {
        const configuration = this.getConfiguration();

        const lintLanguages = new Set(configuration.lintLanguages);
        if (!lintLanguages.has(textDocument.languageId)) {
            return;
        }

        let decoded = '';
        const diagnostics: Diagnostic[] = [];


        const spawnOptions = workspace.rootPath ? { cwd: workspace.rootPath } : undefined;

        let stdout = '-';
        if (process.platform === 'win32') {
            stdout = 'CON';
        }
        const args = [textDocument.fileName,
        '--export-fixes=' + stdout, '-extra-arg=-v'];

        configuration.systemIncludePath.forEach(path => {
            const arg = '-extra-arg=-isystem' + path;
            args.push(arg);
        });

        configuration.extraCompilerArgs.forEach(arg => {
            args.push('-extra-arg=' + arg);
        });

        const childProcess = spawn(configuration.executable, args, spawnOptions);
        console.log(spawnOptions);
        childProcess.on('error', console.error);
        if (childProcess.pid) {
            childProcess.stdout.on('data', (data) => {
                decoded += data;
            });
            childProcess.stderr.on('data', d => {
                console.warn(d.toString());
            });
            childProcess.stdout.on('end', () => {
                const match = decoded.match(/(^\-\-\-(.*\n)*\.\.\.$)/gm);
                if (match && match[0]) {
                    const yaml = match[0];
                    const parsed = safeLoad(yaml) as ClangTidyResult;
                    parsed.Diagnostics.forEach((element: ClangTidyDiagnostic) => {
                        const name: string = element.DiagnosticName;
                        const severity = name.endsWith('error') ?
                            DiagnosticSeverity.Error : DiagnosticSeverity.Warning;
                        const message: string = `[Clang Tidy]${element.Message} (${name})`;
                        const offset: number = element.FileOffset;
                        const startPosition = textDocument.positionAt(offset);

                        const range = new Range(startPosition, startPosition);
                        diagnostics.push(new Diagnostic(range, message, severity));
                    });
                    this.diagnosticCollection.set(textDocument.uri, diagnostics);
                }
            });
        }
    }

    private runCodeAction(document: TextDocument, ) {

    }

    public provideCodeActions(document: TextDocument, range: Range, context: CodeActionContext,
        token: CancellationToken): Command[] {

        const diagnostics = context.diagnostics[0];
        return [{
            title: 'Apply clang-tidy fix',
            command: ClangTidyProvider.commandId,
            arguments: [document, diagnostics.range, diagnostics.message]
        }];
    }

    public activate(subscriptions: Disposable[]) {
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
        this.command.dispose();
    }
}
