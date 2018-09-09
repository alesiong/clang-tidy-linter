'use strict';

import {
    createConnection, TextDocuments, TextDocument, Diagnostic,
    ProposedFeatures, InitializeParams, DidChangeConfigurationNotification,
    CodeActionParams, CodeAction, CodeActionKind, TextEdit, PublishDiagnosticsParams,
} from 'vscode-languageserver';
import { generateDiagnostics } from './tidy';

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments();

let hasConfigurationCapability: boolean = false;
let hasWorkspaceFolderCapability: boolean = false;
// let hasDiagnosticRelatedInformationCapability: boolean = false;

const defaultConfig: Configuration = {
    executable: 'clang-tidy',
    systemIncludePath: [],
    lintLanguages: ["c", "cpp"],
    extraCompilerArgs: ["-Weverything"],
    headerFilter: ".*",
    args: []
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
    const configuration = await getDocumentConfig(textDocument.uri);
    const workspaceFolders  = await connection.workspace.getWorkspaceFolders();
    const lintLanguages = new Set(configuration.lintLanguages);
    if (!lintLanguages.has(textDocument.languageId)) {
        return;
    }

    generateDiagnostics(textDocument, configuration,
                        workspaceFolders ? workspaceFolders : [],
                        diagnostics => {
                            for (const filePath in diagnostics) {
                                const diagnosticsParam: PublishDiagnosticsParams = {
                                    uri: "file://" + filePath,
                                    diagnostics: diagnostics[filePath]
                                };
                                connection.sendDiagnostics(diagnosticsParam);
                            }
                        });
}

async function provideCodeActions(params: CodeActionParams): Promise<CodeAction[]> {
    const diagnostics: Diagnostic[] = params.context.diagnostics;
    const actions: CodeAction[] = [];
    diagnostics
        .filter(d => d.source === 'Clang Tidy')
        .forEach(d => {
            // console.warn("d.code: " + d.code);
            if (d.code && typeof d.code === 'string') {
                const replacements = JSON.parse(d.code) as ClangTidyReplacement[];

                const changes: { [uri: string]: TextEdit[]; } = {};
                for (const replacement of replacements) {
                    // Only add replacement if we have a range. We should do.
                    if (replacement.Range) {
                        // console.warn("replacement: " + replacement.Range);
                        if (!(params.textDocument.uri in changes)) {
                            changes[params.textDocument.uri] = [];
                        }

                        changes[params.textDocument.uri].push({
                            range: replacement.Range,
                            newText: replacement.ReplacementText
                        });
                    }
                }

                actions.push({
                    title: '[Clang Tidy] Change to ' + replacements[0].ReplacementText,
                    diagnostics: [d],
                    kind: CodeActionKind.QuickFix,
                    edit: {
                        changes
                    }
                });

            } else {
                actions.push({
                    title: 'Apply clang-tidy fix [NYI]',
                    diagnostics: [d],
                    kind: CodeActionKind.QuickFix
                });
            }
        });
    return actions;
}

documents.listen(connection);

connection.listen();