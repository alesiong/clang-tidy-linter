'use strict';

import * as path from 'path';
// import ClangTidyProvider from './features/ClangTidyProvider';
import { ExtensionContext, workspace } from 'vscode';
import { LanguageClient, LanguageClientOptions, ServerOptions, TransportKind }
    from 'vscode-languageclient';

let client: LanguageClient;

export function activate(context: ExtensionContext) {
    // const linter = new ClangTidyProvider();
    // linter.activate(context.subscriptions);
    // languages.registerCodeActionsProvider({ scheme: 'file', language: 'cpp' }, linter);
    const serverModule = context.asAbsolutePath(path.join('out', 'server.js'));
    const debugOptions = { execArgv: ["--nolazy", "--inspect=6009"] };

    const serverOptions: ServerOptions = {
        run: { module: serverModule, transport: TransportKind.ipc },
        debug: { module: serverModule, transport: TransportKind.ipc, options: debugOptions }
    };

    const clientOptions: LanguageClientOptions = {
        documentSelector: [
            { scheme: 'file', language: 'cpp' }
        ],
        synchronize: {
            fileEvents: workspace.createFileSystemWatcher('**/*'),
        }
    };

    // Create the language client and start the client.
    client = new LanguageClient('clangTidy', 'Clang Tidy Linter Client',
        serverOptions, clientOptions);

    console.log('start');
    client.start();
}


export function deactivate() {
}
