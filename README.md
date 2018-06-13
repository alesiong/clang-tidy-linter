# Clang Tidy Linter

This extension uses [clang-tidy](http://clang.llvm.org/extra/clang-tidy/) to lint C/C++ files.

**This extension is in a very early stage of development.** You will need to do some configuration before you can use it. But this extension is still kind of "usable".

## Features

Currently you can only use this extension as a linter, the auto-fix will be added in the future.

## Requirements

As for now you have to download/compile the clang-tidy executable. Maybe executables will be shipped with this extension in the future. The download link for official prebuilt binaries is <http://releases.llvm.org/download.html>.

## Extension Settings

You may need to modify some default settings to get this extension to work for now.

`clangTidy.executable`: You need to manually set this to your `clang-tidy` executable file.

`clangTidy.systemIncludePath`: If you use the downloaded prebuilt binaries, it may fail to find some system headers. So put the system include paths here.

`clangTidy.lintLanguages`: What languages do you want to lint?

`clangTidy.extraCompilerArgs`: Extra arguments that pass to the **compiler** (not `clang-tidy`).

If you want to configure the checks of clang tidy, create a `.clang-tidy` file in your working directory (please refer to the `clang-tidy`'s document for detail).

## Known Issues



## Contribution
Repository: <https://github.com/alesiong/clang-tidy-linter>

## Release Notes

Users appreciate release notes as you update your extension.

### 0.0.1

The very first beta version published to the market.
