'use strict';

import {
    createConnection, TextDocuments, TextDocument, Diagnostic, DiagnosticSeverity,
    ProposedFeatures, InitializeParams, DidChangeConfigurationNotification, Range,
    CodeActionParams, CodeAction, CodeActionKind, TextEdit
} from 'vscode-languageserver';
import Uri from 'vscode-uri';
import { spawn } from 'child_process';
import { safeLoad } from 'js-yaml';
import * as fs from 'fs';
import * as path from 'path';

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments();

let hasConfigurationCapability: boolean = false;
let hasWorkspaceFolderCapability: boolean = false;
// let hasDiagnosticRelatedInformationCapability: boolean = false;

const defaultConfig: Configuration = {
    executable: 'clang-tidy',
    systemIncludePath: [],
    lintLanguages: ["c", "cpp"],
    extraCompilerArgs: ["-Weverything"]
};

let globalConfig = defaultConfig;

const documentConfig: Map<string, Thenable<Configuration>> = new Map();


connection.onInitialize((params: InitializeParams) => {
    const capabilities = params.capabilities;

    hasConfigurationCapability = !!(capabilities.workspace && !!capabilities.workspace.configuration);
    hasWorkspaceFolderCapability = !!(capabilities.workspace && !!capabilities.workspace.workspaceFolders);
    // hasDiagnosticRelatedInformationCapability = !!(capabilities.textDocument &&
    //     capabilities.textDocument.publishDiagnostics &&
    //     capabilities.textDocument.publishDiagnostics.relatedInformation);
    return {
        capabilities: {
            textDocumentSync: documents.syncKind,
            codeActionProvider: true
        }
    };
});

connection.onInitialized(() => {
    if (hasConfigurationCapability) {
        connection.client.register(DidChangeConfigurationNotification.type, undefined);
    }
    if (hasWorkspaceFolderCapability) {
        connection.workspace.onDidChangeWorkspaceFolders((_event) => {
            connection.console.log('Workspace folder change event received.');
        });
    }
});

connection.onDidChangeConfiguration(change => {
    if (hasConfigurationCapability) {
        documentConfig.clear();
    } else {
        globalConfig = change.settings.clangTidy || defaultConfig;
    }
    documents.all().forEach(validateTextDocument);
});

connection.onCodeAction(provideCodeActions);

documents.onDidClose(e => {
    documentConfig.delete(e.document.uri);
});

documents.onDidSave(file => {
    validateTextDocument(file.document);
});

documents.onDidOpen(file => {
    validateTextDocument(file.document);
});


// Get config by document url (resource)
function getDocumentConfig(resource: string): Thenable<Configuration> {
    if (!hasConfigurationCapability) {
        return Promise.resolve(globalConfig);
    }
    let result = documentConfig.get(resource);
    if (!result) {
        result = connection.workspace.getConfiguration({
            scopeUri: resource,
            section: 'clangTidy'
        });
        documentConfig.set(resource, result);
    }
    return result;
}

async function validateTextDocument(textDocument: TextDocument): Promise<void> {
    const workspaceFolders = await connection.workspace.getWorkspaceFolders();
    const cppToolsIncludePaths: string[] = [];
    let cStandard: string = '';
    let cppStandard: string = '';


    if (workspaceFolders) {
        workspaceFolders.forEach(folder => {
            const config = path.join(Uri.parse(folder.uri).fsPath, '.vscode/c_cpp_properties.json');
            if (fs.existsSync(config)) {
                const content = fs.readFileSync(config, { encoding: 'utf8' });
                const configJson = JSON.parse(content);
                if (configJson.configurations) {
                    configJson.configurations.forEach((config: any) => {
                        if (config.includePath) {
                            config.includePath.forEach((path: string) => {
                                cppToolsIncludePaths.push(path.replace('${workspaceFolder}', '.'));
                            });
                        }
                        cStandard = config.cStandard;
                        cppStandard = config.cppStandard;
                    });
                }
            }
        });
    }

    const configuration = await getDocumentConfig(textDocument.uri);
    const lintLanguages = new Set(configuration.lintLanguages);
    if (!lintLanguages.has(textDocument.languageId)) {
        return;
    }

    let decoded = '';
    const diagnostics: Diagnostic[] = [];
    const spawnOptions = undefined;

    // const spawnOptions = workspace.rootPath ? { cwd: workspace.rootPath } : undefined;
    const filePath = Uri.parse(textDocument.uri).fsPath;
    const args = [filePath, '--export-fixes=-', '-p=.'];

    configuration.systemIncludePath.forEach(path => {
        const arg = '-extra-arg=-isystem' + path;
        args.push(arg);
    });

    configuration.extraCompilerArgs.forEach(arg => {
        args.push('-extra-arg-before=' + arg);
    });

    if (textDocument.languageId === 'c') {
        args.push('-extra-arg-before=-xc');
        if (cStandard) {
            args.push('-extra-arg-before=-std=' + cStandard);
        }
    }

    if (textDocument.languageId === 'cpp') {
        args.push('-extra-arg-before=-xc++');
        if (cppStandard) {
            args.push('-extra-arg-before=-std=' + cppStandard);
        }
    }

    cppToolsIncludePaths.forEach(path => {
        const arg = '-extra-arg=-isystem' + path;
        args.push(arg);
    });

    const childProcess = spawn(configuration.executable, args, spawnOptions);

    childProcess.on('error', console.error);
    if (childProcess.pid) {
        childProcess.stdout.on('data', (data) => {
            decoded += data;
        });
        childProcess.stdout.on('end', () => {
            console.log(decoded);
            const match = decoded.match(/(^\-\-\-(.*\n)*\.\.\.$)/gm);
            if (match && match[0]) {
                const yaml = match[0];
                const parsed = safeLoad(yaml) as ClangTidyResult;
                parsed.Diagnostics.forEach((element: ClangTidyDiagnostic) => {
                    if (element.FilePath && element.FilePath !== filePath) {
                        return;
                    }
                    const name: string = element.DiagnosticName;
                    const severity = name.endsWith('error') ?
                        DiagnosticSeverity.Error : DiagnosticSeverity.Warning;
                    const message: string = `${element.Message} (${name})`;
                    const offset: number = element.FileOffset;

                    let range: Range;
                    if (element.Replacements && element.Replacements.length > 0) {
                        const start = element.Replacements[0].Offset;
                        const end = start + element.Replacements[0].Length;
                        range = Range.create(textDocument.positionAt(start),
                            textDocument.positionAt(end));
                    } else {
                        const startPosition = textDocument.positionAt(offset);
                        range = Range.create(startPosition, startPosition);
                    }
                    diagnostics.push(Diagnostic.create(range, message, severity,
                        element.Replacements && JSON.stringify(element.Replacements),
                        'Clang Tidy'));
                });

                connection.sendDiagnostics({
                    uri: textDocument.uri,
                    diagnostics
                });
            }
        });
    }
}

async function provideCodeActions(params: CodeActionParams): Promise<CodeAction[]> {
    const diagnostics: Diagnostic[] = params.context.diagnostics;
    const actions: CodeAction[] = [];
    diagnostics
        .filter(d => d.source === 'Clang Tidy')
        .forEach(d => {
            if (d.code && typeof d.code === 'string') {
                const replacement = JSON.parse(d.code) as ClangTidyReplacement[];
                replacement.forEach(r => {
                    const changes: { [uri: string]: TextEdit[]; } = {};
                    changes[params.textDocument.uri] = [{
                        range: d.range,
                        newText: r.ReplacementText
                    }];

                    actions.push({
                        title: '[Clang Tidy] Change to ' + r.ReplacementText,
                        diagnostics: [d],
                        kind: CodeActionKind.QuickFix,
                        edit: {
                            changes
                        }
                    });
                });

            } else {
                actions.push({
                    title: 'Apply clang-tidy fix',
                    diagnostics: [d],
                    kind: CodeActionKind.QuickFix
                });
            }
        });
    return actions;
}

documents.listen(connection);

connection.listen();