
import {
    Diagnostic, DiagnosticSeverity, TextDocument, WorkspaceFolder, Connection
} from 'vscode-languageserver';
import { spawn } from 'child_process';
import { safeLoad } from 'js-yaml';
import Uri from 'vscode-uri';
import * as path from 'path';
import * as fs from 'fs';

// Invoke clang-tidy and transform it issues into a file/Diagnostics map.
//
// This invoke clang-tidy with the configured arguments and parses the results into vscode-languageserver.Diagnostic
// objects. Each diagnostic contains the set of replacements clang-tidy recommends to address the issue.
// The original clang-tidy recommendations are stored in the Diagnostic.code member in JSON string format. This can be
// parsed into a ClangTidyDiagnostic.
//
// The ClangTidyDiagnostic and associated ClangTidyReplacement objects are extended to each contain a Range member.
// This member is an alias for the FileOffset/Offset + Length members into a vscode-languageserver.Range value. This
// better supports integration with vscode we have sufficient data to more easily resolve the range value here rather
// than later.
//
// textDocument: The TextDocument to lint using clang-tidy
// configuration: Details of the clang-tidy-linter extension configuration; i.e., how to invoke clang-tidy.
// onParsed: Callback to invoke once the diagnostics are generated. The argument holds a dictionary of results.
//      These are keyed on absolute file path (not URI) and the array of associated Diagnostics for that file.
export function generateDiagnostics(
    connection: Connection,
    textDocument: TextDocument, configuration: Configuration,
    workspaceFolders: WorkspaceFolder[],
    onParsed: (doc: TextDocument, diagnostics: { [id: string]: Diagnostic[] },
        diagnosticsCount: number) => void) {

    let decoded = '';
    // Dictionary of collated diagnostics keyed on absolute file name. This supports source files generating
    // diagnostics for header files.
    const diagnostics: { [id: string]: Diagnostic[]; } = {};
    let diagnosticsCount: number = 0;
    // Dictionary of text documents used to resolve character offsets into ranges.
    // We need to support the textDocument and additional included files (e.g., header files) and use it to resolve
    // file level character offsets into line/character offsets used by VSCode.
    // Keyed on absolute file name.
    const docs: { [id: string]: TextDocument } = {};

    let cppToolsConfigs: CppToolsConfigs | null = null;
    if (workspaceFolders) {
        cppToolsConfigs = readConfigFromCppTools(workspaceFolders);
    }

    // Immediately add entries for the textDocument.
    diagnostics[Uri.parse(textDocument.uri).fsPath] = [];
    docs[Uri.parse(textDocument.uri).fsPath] = textDocument;

    const args = [Uri.parse(textDocument.uri).fsPath, '--export-fixes=-'];

    if (configuration.headerFilter) {
        args.push('-header-filter=' + configuration.headerFilter);
    }

    configuration.systemIncludePath.forEach(path => {
        const arg = '-extra-arg=-isystem' + path;
        args.push(arg);
    });

    configuration.extraCompilerArgs.forEach(arg => {
        args.push('-extra-arg-before=' + arg);
    });

    configuration.args.forEach(arg => {
        args.push(arg);
    });

    if (cppToolsConfigs) {
        const { cppToolsIncludePaths, cStandard, cppStandard } = cppToolsConfigs;
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
            const arg = '-extra-arg=-I' + path;
            args.push(arg);
        });
    }

    // Replace ${workspaceFolder} in arguments. Seem to be a number of issues open regarding
    // support for this in the VSCode API, but I can't find a solution.
    if (workspaceFolders) {
        const workspaceFolder = Uri.parse(workspaceFolders[0].uri).fsPath;
        args.forEach(function (arg, index) {
            args[index] = arg.replace("${workspaceFolder}", workspaceFolder);
        });
    }

    // console.warn("clang-tidy with args: " + args);
    const childProcess = spawn(configuration.executable, args);

    const workspaceOnly = configuration.workspaceOnly;
    const excludes = configuration.excludes;

    childProcess.on('error', console.error);
    if (childProcess.pid) {
        childProcess.stdout.on('data', (data) => {
            decoded += data;
        });
        childProcess.stdout.on('end', () => {
            const match = decoded.match(/(^\-\-\-(.*\n)*\.\.\.$)/gm);
            if (match && match[0]) {
                const yaml = match[0];
                const parsed = safeLoad(yaml) as ClangTidyResult;
                parsed.Diagnostics.forEach((element: ClangTidyDiagnostic) => {
                    const filePath = element.FilePath;
                    if (excludes && excludes.some(s => filePath.includes(s))) {
                        return;
                    }

                    if (workspaceOnly && workspaceFolders &&
                        !workspaceFolders.some(s => filePath.startsWith(Uri.parse(s.uri).fsPath))) {
                        return;
                    }

                    const name: string = element.DiagnosticName;
                    const severity = name.endsWith('error') ?
                        DiagnosticSeverity.Error : DiagnosticSeverity.Warning;
                    const message: string = `${element.Message} (${name})`;

                    // Helper function to ensure absolute paths and required registrations are made.
                    function fixPath(filePath: string): string {
                        if (filePath && !path.isAbsolute(filePath)) {
                            filePath = path.resolve(path.dirname(Uri.parse(textDocument.uri).fsPath),
                                filePath);
                        }

                        if (!(filePath in diagnostics)) {
                            diagnostics[filePath] = [];
                        }

                        // Resolve replacement.FileOffset and replacement.Length into a range.
                        let doc: TextDocument | undefined = undefined;

                        // Resolve the document.
                        if (!(filePath in docs)) {
                            // Unresolved. We'll create a new TextDocument reference loading the content.
                            // This is potentially inefficient, and it would be nice to see if we can leverage
                            // VSCode to manage this.
                            if (fs.existsSync(filePath)) {
                                doc = TextDocument.create("file://" + filePath,
                                    textDocument.languageId, 0,
                                    fs.readFileSync(filePath).toString());
                                docs[filePath] = doc;
                            }
                        }

                        return filePath;
                    }

                    // Create a dictionary of diagnostics ensuring we use absolute paths to handle errors from headers.
                    const clangTidySourceName: string = 'Clang Tidy';

                    // Ensure an absolute path for the main clang-tidy element.
                    element.FilePath = fixPath(element.FilePath);

                    // Iterate the replacements to:
                    // - Ensure absolute paths.
                    // - Resolve clang's character offset and length to a line and character range.
                    if (element.Replacements) {
                        for (const replacement of element.Replacements) {
                            // Ensure replacement FilePath entries use absolute paths.
                            replacement.FilePath = fixPath(element.FilePath);

                            // Create a diagnostic for the replacement. The context of each replacement may be a
                            // different file from the element's FilePath.
                            let doc: TextDocument;
                            if (replacement.FilePath in docs) {
                                doc = docs[replacement.FilePath];

                                //replacement.Offset is byte offset, not the character offset
                                //when your source file contains some symbol which takes more than one byte
                                //to encode, it will cause error.
                                const doc_buff = Buffer.from(doc.getText());
                                const character_offset = doc_buff.toString('utf-8',0,replacement.Offset).length;

                                replacement.Range = {
                                    start: doc.positionAt(character_offset),
                                    end: doc.positionAt(character_offset + replacement.Length)
                                };
                            }
                        }
                    }
                    // Create a VSCode Diagnostic. Use the original textDocument if we fail to resolve the document
                    // path. This ensures the user gets feedback.
                    const doc = element.FilePath in docs ? docs[element.FilePath] : textDocument;
                    element.Range = {
                        start: doc.positionAt(element.FileOffset),
                        end: doc.positionAt(element.FileOffset)
                    };

                    const diagnostic: Diagnostic = Diagnostic.create(element.Range, message, severity,
                        element.Replacements && JSON.stringify(element.Replacements), clangTidySourceName);

                    diagnostics[element.FilePath].push(diagnostic);
                    ++diagnosticsCount;

                });
            }

            onParsed(textDocument, diagnostics, diagnosticsCount);
        });
    }
}

function walkDir(dir: string, recursive: boolean, fn: (dir: string) => void) {
    fs.readdirSync(dir).forEach(file => {
        const s = path.join(dir, file);
        if (fs.lstatSync(s).isDirectory()) {
            fn(s);
            walkDir(s, recursive, fn);
        }
    });
}

function readConfigFromCppTools(workspaceFolders: WorkspaceFolder[]): CppToolsConfigs {
    const cppToolsIncludePaths: string[] = [];
    let cStandard: string = '';
    let cppStandard: string = '';

    workspaceFolders.forEach(folder => {
        const workspacePath = Uri.parse(folder.uri).fsPath;
        const config = path.join(workspacePath, '.vscode/c_cpp_properties.json');
        if (fs.existsSync(config)) {
            const content = fs.readFileSync(config, { encoding: 'utf8' });
            const configJson = JSON.parse(content);
            if (configJson.configurations) {
                configJson.configurations.forEach((config: any) => {
                    if (config.includePath) {
                        config.includePath.forEach((incPath: string) => {
                            incPath = incPath.replace('${workspaceFolder}', '.');
                            if (incPath.endsWith('**')) {
                                let s = incPath.substring(0, incPath.length - 2);
                                s = path.resolve(workspacePath, s);
                                cppToolsIncludePaths.push(s);
                                walkDir(s, true, (dir: string) => {
                                    cppToolsIncludePaths.push(dir);
                                });
                            } else if (incPath.endsWith('*')) {
                                let s = incPath.substring(0, incPath.length - 1);
                                s = path.resolve(workspacePath, s);
                                cppToolsIncludePaths.push(s);
                                walkDir(s, false, (dir: string) => {
                                    cppToolsIncludePaths.push(dir);
                                });
                            } else {
                                cppToolsIncludePaths.push(path.resolve(workspacePath, incPath));
                            }
                        });
                    }
                    cStandard = config.cStandard;
                    cppStandard = config.cppStandard;
                });
            }
        }
    });

    return {
        cppToolsIncludePaths, cStandard, cppStandard
    };
}
