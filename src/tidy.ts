
import {
    Diagnostic, DiagnosticSeverity, TextDocument, WorkspaceFolder
} from 'vscode-languageserver';
import { spawn } from 'child_process';
import { safeLoad } from 'js-yaml';
import Uri from 'vscode-uri';
import * as path from 'path';
import * as fs from 'fs';
import { isValide } from "./utils";


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
    const textDocumentPath = Uri.parse(textDocument.uri).fsPath;

    function resolveFilePath(filePath: string): string {
        if (filePath === '') {
            return textDocumentPath;
        }
        filePath = path.resolve(filePath);

        return isValide(filePath, configuration, workspaceFolders)? filePath: "";
    }

    // Immediately add entries for the textDocument.
    diagnostics[textDocumentPath] = [];
    docs[textDocumentPath] = textDocument;
    const args = configuration.args;

    if (textDocument.languageId === 'c') {
        args.push('-extra-arg-before=-xc');
        if (configuration.cStandard) {
            args.push('-extra-arg-before=-std=' + configuration.cStandard);
        }
    }

    if (textDocument.languageId === 'cpp') {
        args.push('-extra-arg-before=-xc++');
        if (configuration.cppStandard) {
            args.push('-extra-arg-before=-std=' + configuration.cppStandard);
        }
    }
    args.push(textDocumentPath);
    const childProcess = spawn(configuration.executable, args);

    function addDiagnostic(filePath: string, range: Range, message: string,
        severity: DiagnosticSeverity, code?: number | string) {
        const diagnostic: Diagnostic = Diagnostic.create(range, message, severity,
            code, 'Clang Tidy');

        if (!(filePath in diagnostics)) {
            diagnostics[filePath] = [];
        }
        diagnostics[filePath].push(diagnostic);
        ++diagnosticsCount;
    }

    function parseCompilerError() {
        const regex = /(.*):(\d+):(\d+):\s(\w+):(.*)\n(.*\n.*)/gm;
        let matchs: RegExpExecArray | null;
        while ((matchs = regex.exec(decoded)) !== null) {
            if (matchs.index === regex.lastIndex) {
                regex.lastIndex++;
            }
            if (matchs.length >= 7) {
                const filePath = resolveFilePath(matchs[1]);
                if (filePath === '') {
                    continue;
                }

                const line = Number(matchs[2]) - 1;
                const col = Number(matchs[3]) - 1;
                const severity = matchs[4].endsWith('error') ?
                    DiagnosticSeverity.Error : DiagnosticSeverity.Warning;
                if (severity !== DiagnosticSeverity.Error) {
                    continue;
                }
                const message = matchs[5];
                const reason = matchs[6];
                const range = {
                    start: {
                        line: line,
                        character: col
                    },
                    end: {
                        line: line,
                        character: col
                    }
                };

                addDiagnostic(filePath, range, message + '\n' + reason, severity);
            }
        }
    }

    function parseTidyWarn() {
        const replacements: ClangTidyReplacementFix[] = [];
        const match = decoded.match(/(^\-\-\-(.*\n)*\.\.\.$)/gm);
        if (match && match[0]) {
            const yaml = match[0];
            const parsed = safeLoad(yaml) as ClangTidyResult;
            parsed.Diagnostics.forEach((element: ClangTidyDiagnostic) => {
                element.FilePath = resolveFilePath(element.FilePath);
                if (element.FilePath === '') {
                    return;
                }

                const name: string = element.DiagnosticName;
                if (name.endsWith('error')) {
                    return;
                }
                const severity = DiagnosticSeverity.Warning;
                const message: string = `${element.Message} (${name})`;

                let doc: TextDocument | null = null;
                if (element.FilePath in docs) {
                    doc = docs[element.FilePath];
                } else {
                    // Unresolved. We'll create a new TextDocument reference loading the content.
                    // This is potentially inefficient, and it would be nice to see if we can leverage
                    // VSCode to manage this.
                    if (fs.existsSync(element.FilePath)) {
                        try {
                            // Resolve replacement.FileOffset and replacement.Length into a range.
                            doc = TextDocument.create("file://" + element.FilePath,
                                textDocument.languageId, 0,
                                fs.readFileSync(element.FilePath).toString());
                            docs[element.FilePath] = doc;
                        } catch (error) {
                            console.error(element.FilePath, ':', error);
                        }
                    }
                }


                // Iterate the replacements to:
                // - Ensure absolute paths.
                // - Resolve clang's character offset and length to a line and character range.
                if (element.Replacements) {
                    for (const replacement of element.Replacements) {
                        const replacementFix: ClangTidyReplacementFix = {
                            t: replacement.ReplacementText
                        };
                        // Ensure replacement FilePath entries use absolute paths.
                        //replacement.FilePath = element.FilePath;

                        // Create a diagnostic for the replacement. The context of each replacement may be a
                        // different file from the element's FilePath.
                        if (doc) {
                            //replacement.Offset is byte offset, not the character offset
                            //when your source file contains some symbol which takes more than one byte
                            //to encode, it will cause error.
                            const doc_buff = Buffer.from(doc.getText());
                            const character_offset = doc_buff.toString('utf-8', 0, replacement.Offset).length;

                            replacementFix.r = {
                                start: doc.positionAt(character_offset),
                                end: doc.positionAt(character_offset + replacement.Length)
                            };
                        }
                        replacements.push(replacementFix);
                    }
                }

                // Create a VSCode Diagnostic. Use the original textDocument if we fail to resolve the document
                // path. This ensures the user gets feedback.
                if (doc) {
                    element.Range = {
                        start: doc.positionAt(element.FileOffset),
                        end: doc.positionAt(element.FileOffset)
                    };
                } else {
                    element.Range = {
                        start: textDocument.positionAt(element.FileOffset),
                        end: textDocument.positionAt(element.FileOffset)
                    };
                }

                addDiagnostic(element.FilePath, element.Range, message, severity,
                    replacements.length > 0? JSON.stringify(replacements): undefined);
            });
        }
    }


    childProcess.on('error', console.error);
    if (childProcess.pid) {
        childProcess.stderr.on('data', data => {
            // console.error(data.toString());
        });
        childProcess.stdout.on('data', (data) => {
            decoded += data;
        });
        childProcess.stdout.on('end', () => {
            parseCompilerError();
            parseTidyWarn();
            onParsed(textDocument, diagnostics, diagnosticsCount);
        });
    }
}
