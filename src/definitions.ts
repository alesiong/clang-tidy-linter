interface Configuration {
    executable: string;
    systemIncludePath: string[];
    lintLanguages: string[];
    extraCompilerArgs: string[];
}

interface ClangTidyResult {
    MainSourceFile: string;
    Diagnostics: ClangTidyDiagnostic[];
}

interface ClangTidyDiagnostic {
    DiagnosticName: string;
    Message: string;
    FileOffset: number;
    FilePath: string;
    Replacements: ClangTidyReplacement[];
}

interface ClangTidyReplacement {
    FilePath: string;
    Offset: number;
    Length: number;
    ReplacementText: string;
}