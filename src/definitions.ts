interface Configuration {
    executable: string;
    systemIncludePath: string[];
    lintLanguages: string[];
    extraCompilerArgs: string[];
    headerFilter: string;
    args: string[];
    excludes: string[];
    workspaceOnly: boolean;

    defaultWorkspaceFolder: string;
    genArgs: string[];
    cStandard: string;
    cppStandard: string;
}

interface ClangTidyResult {
    MainSourceFile: string;
    Diagnostics: ClangTidyDiagnostic[];
}

interface Position {
    line: number;
    character: number;
}

interface Range {
    start: Position;
    end: Position;
}

interface ClangTidyDiagnostic {
    DiagnosticName: string;
    Message: string;
    FileOffset: number;
    FilePath: string;
    Replacements?: ClangTidyReplacement[];
    Range?: Range;  // Offset and length translated into line character
}

interface ClangTidyReplacement {
    FilePath: string;
    Offset: number;
    Length: number;
    ReplacementText: string;
    //Range?: Range;  // Offset and length translated into line character
}

interface ClangTidyReplacementFix {
    t: string;
    r?: Range;  // Offset and length translated into line character
}

interface CppToolsConfigs {
    cppToolsIncludePaths: string[];
    cStandard: string;
    cppStandard: string;
}
