# Clang Tidy Linter

This extension uses [clang-tidy](http://clang.llvm.org/extra/clang-tidy/) to lint C/C++ files.

**This extension is in a very early stage of development.** You will need to do some configuration before you can use it. But this extension is still kind of "usable".

## Features

Basic diagnostic(linter) and quick fixes for the C/C++ source files with the clang-tidy.

## Requirements

As for now you have to download/compile the clang-tidy executable. Maybe executables will be shipped with this extension in the future. The download link for official prebuilt binaries is <http://releases.llvm.org/download.html>.

## Extension Settings

You may need to modify some default settings to get this extension to work for now.

`clangTidy.executable`: You need to manually set this to your `clang-tidy` executable file.

`clangTidy.systemIncludePath`: If you use the downloaded prebuilt binaries, it may fail to find some system headers. So put the system include paths here.

`clangTidy.lintLanguages`: What languages do you want to lint?

`clangTidy.extraCompilerArgs`: Extra arguments that pass to the **compiler** (not `clang-tidy`).

`clangTidy.headerFilter`: Value for `-header-filter` command line argument.

`clangTidy.args`: Additional arguments to pass to `clang-tidy`

`clangTidy.excludes`: Don't show message if file path of document in the excludes

`clangTidy.workspaceOnly`: Limit messages to document on the workspaces folders

If you want to configure the checks of clang tidy, create a `.clang-tidy` file in your working directory (please refer to the `clang-tidy`'s document for detail).

## Known Issues

Source files can only be lint when you save or open it.

You have to modify `clangTidy.extraCompilerArgs` setting if your C/C++ project has custom include paths.

## Contribution

Repository: <https://github.com/alesiong/clang-tidy-linter>

I'm a beginner to vscode extension development, so if you have any suggestions, don't hesitate to post issues and/or pull requests.

## Road Map (TODOs)

1. Refactor `server.ts`, it is now in a very bad structure (with lots of functions and global variables)

2. Write tests

3. Support for on-the-fly linting (if possible)

4. Support for use custom `defines` in `.vscode/c_cpp_properties.json`

5. Ship clang-tidy binaries

6. Reconfiguration when `.vscode/c_cpp_properties.json`

## Know Issues

- When using `-p compile_commands.json`, saving a header or opening a header file for the first time can clear existing quick fixes for that file.
  - To regenerate the fixes, touch a cpp file which includes that header file.
  - `compile_commands.json` can be generated from CMake when `CMAKE_EXPORT_COMPILE_COMMANDS` is on.

## Release Notes

### 0.0.1

The very first beta version published to the market.

### 0.0.2

Support Windows (not tested).
Add code actions(quick fixes) support.
