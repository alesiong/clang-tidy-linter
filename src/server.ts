'use strict';

import {
    createConnection, TextDocuments, TextDocument, Diagnostic, DiagnosticSeverity,
    ProposedFeatures, InitializeParams, DidChangeConfigurationNotification, Range
} from 'vscode-languageserver';
import Uri from 'vscode-uri';
import { spawn } from 'child_process';
import { safeLoad } from 'js-yaml';


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
            textDocumentSync: documents.syncKind
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

documents.onDidClose(e => {
    documentConfig.delete(e.document.uri);
});

documents.onDidChangeContent(change => {
    console.log('change');
    validateTextDocument(change.document);
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
    console.log('validate');
    const configuration = await getDocumentConfig(textDocument.uri);
    console.log(configuration.executable);
    const lintLanguages = new Set(configuration.lintLanguages);
    if (!lintLanguages.has(textDocument.languageId)) {
        return;
    }

    let decoded = '';
    const diagnostics: Diagnostic[] = [];
    const spawnOptions = undefined;

    // const spawnOptions = workspace.rootPath ? { cwd: workspace.rootPath } : undefined;

    const args = [Uri.parse(textDocument.uri).fsPath,
        '--export-fixes=-', '-extra-arg=-v', '-header-filter=.*'];

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

                    const range = Range.create(startPosition, startPosition);
                    diagnostics.push(Diagnostic.create(range, message, severity));
                });
                connection.sendDiagnostics({
                    uri: textDocument.uri,
                    diagnostics
                });
            }
        });
    }
}

documents.listen(connection);

connection.listen();