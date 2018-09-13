'use strict';

import {
    createConnection, TextDocuments, TextDocument, Diagnostic,
    ProposedFeatures, InitializeParams, DidChangeConfigurationNotification,
    CodeActionParams, CodeAction, CodeActionKind, TextEdit, PublishDiagnosticsParams,
} from 'vscode-languageserver';
import Uri from 'vscode-uri';
import { generateDiagnostics } from './tidy';
import * as path from 'path';
import * as fs from 'fs';

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments();
// Keyed on files that raised diagnostics, but were not the mail file; i.e., header files.
// Used to recompile header files as they won't generate diagnostics when using a build database (-p option).
const fileAssociationMap: { [id: string]: string } = {};

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


function getAlternativeDoc(filePath: string, languageId: string): TextDocument | undefined {
    // Try associated file map.
    if (filePath in fileAssociationMap) {
        const aliasDocPath = fileAssociationMap[filePath];
        if (fs.existsSync(aliasDocPath)) {
            const referenceDoc = TextDocument.create("file://" + aliasDocPath,
                languageId, 0,
                fs.readFileSync(aliasDocPath).toString());
            return referenceDoc;
        }
    }

    // Assume it's a header file and look for a matching source file in the same directory.
    // It would be better to query VSCode for this as it has better overall visibility of matching source to header.
    const basePath = path.parse(Uri.parse(filePath).fsPath);
    const tryExtensions = [ "c", "cpp", "cxx" ];

    for (const ext of tryExtensions) {
        const tryPath = path.join(basePath.dir, basePath.name + "." + ext);
        // console.warn("Try: " + tryPath);
        if (fs.existsSync(tryPath)) {
            const referenceDoc = TextDocument.create("file://" + tryPath,
                languageId, 0,
                fs.readFileSync(tryPath).toString());
            return referenceDoc;
        }
    }

    return undefined;
}

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

    const folders = workspaceFolders ? workspaceFolders : [];

    let allowRecursion: boolean = true;
    const processResults = (doc: TextDocument, diagnostics: { [id: string]: Diagnostic[] }, diagnosticsCount: number) =>
    {
        const mainFilePath: string = Uri.parse(textDocument.uri).fsPath;
        let sentDiagnostics: boolean = false;

        if (diagnosticsCount == 0 && allowRecursion) {
            // No diagnostics. Could be because of the build database issue.
            // Recurse on the best alternative file.
            allowRecursion = false;
            const referenceDoc = getAlternativeDoc(mainFilePath, textDocument.languageId);
            // console.warn("No diagnostics for " + mainFilePath);
            // console.warn("Alternative: " + (referenceDoc ? referenceDoc.uri : ""));
            if (referenceDoc) {
                sentDiagnostics = true;
                generateDiagnostics(referenceDoc, configuration, folders, processResults);
            }
        }

        if (!sentDiagnostics) {
            for (const filePath in diagnostics) {
                const diagnosticsParam: PublishDiagnosticsParams = {
                    uri: "file://" + filePath,
                    diagnostics: diagnostics[filePath]
                };
                // Cache associated files.
                if (filePath !== mainFilePath) {
                    fileAssociationMap[filePath] = mainFilePath;
                }
                connection.sendDiagnostics(diagnosticsParam);

                // if mainFilePath != textDocument.uri and textDocument.uri not i diagnostics, send empty
                // for textDocument.uri
                if (doc.uri !== textDocument.uri) {
                    if (!(Uri.parse(textDocument.uri).fsPath in diagnostics)) {
                        const diagnosticsParam: PublishDiagnosticsParams = {
                            uri: textDocument.uri,
                            diagnostics: []
                        };
                        connection.sendDiagnostics(diagnosticsParam);
                    }
                }
            }
        }
    };


    generateDiagnostics(textDocument, configuration, folders, processResults);
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