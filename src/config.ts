import Uri from 'vscode-uri';
import * as path from 'path';
import * as fs from 'fs';
import { WorkspaceFolder } from "vscode-languageclient";

export function isValide(filePath: string, config: Configuration, workspaceFolders: WorkspaceFolder[]): boolean {
  if (config.excludes && config.excludes.some(s => filePath.includes(s))) {
    return false;
  }

  if (config.workspaceOnly && workspaceFolders &&
    !workspaceFolders.some(s => filePath.startsWith(Uri.parse(s.uri).fsPath))) {
    return false;
  }

  return true;
}

// resolve {$workspaceFolder} and {$workspaceFolder:Name} in pathIn
// resolve relative path base on workspaceFolder
function resolvePath(pathIn: string, workspaceFolder: string, workspaceFolders: WorkspaceFolder[]): string {
  let s = pathIn.replace('${workspaceFolder}', workspaceFolder);
  if (workspaceFolders) {
    workspaceFolders.forEach(wf => {
      s = s.replace('${workspaceFolder:' + wf.name + '}',
        Uri.parse(wf.uri).fsPath);
    });
  }
  return path.resolve(workspaceFolder, s);
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

  function pushIncPath(s: string) {
    if (cppToolsIncludePaths.indexOf(s) < 0) {
      cppToolsIncludePaths.push(s);
    }
  }

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
              incPath = resolvePath(incPath, workspacePath, workspaceFolders);
              if (incPath.endsWith('/**')) {
                const s = incPath.substring(0, incPath.length - 3);
                pushIncPath(s);
                walkDir(s, true, (dir: string) => {
                  pushIncPath(dir);
                });
              } else if (incPath.endsWith('/*')) {
                const s = incPath.substring(0, incPath.length - 2);
                pushIncPath(s);
                walkDir(s, false, (dir: string) => {
                  pushIncPath(dir);
                });
              } else {
                pushIncPath(incPath);
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

export function initConfig(configuration: Configuration, workspaceFolders: WorkspaceFolder[]): Configuration {

  configuration.genArgs = [];

  configuration.defaultWorkspaceFolder = workspaceFolders && workspaceFolders.length > 0 ?
    Uri.parse(workspaceFolders[0].uri).fsPath : '.';

  configuration.excludes.forEach((exclude, index) => {
    configuration.excludes[index] = resolvePath(exclude, configuration.defaultWorkspaceFolder, workspaceFolders)
  });

  configuration.genArgs.push('--export-fixes=-');

  if (configuration.headerFilter) {
    configuration.genArgs.push('-header-filter=' + configuration.headerFilter);
  }

  configuration.systemIncludePath.forEach(path => {
    const arg = '-extra-arg=-isystem' + resolvePath(path, configuration.defaultWorkspaceFolder, workspaceFolders);
    configuration.genArgs.push(arg);
  });

  configuration.extraCompilerArgs.forEach(arg => {
    configuration.genArgs.push('-extra-arg-before=' + arg);
  });

  configuration.args.forEach(arg => {
    configuration.genArgs.push(arg);
  });

  if (workspaceFolders) {
    const cppToolsConfigs = readConfigFromCppTools(workspaceFolders);
    if (cppToolsConfigs) {
      const { cppToolsIncludePaths, cStandard, cppStandard } = cppToolsConfigs;
      configuration.cStandard = cStandard;
      configuration.cppStandard = cppStandard;
      cppToolsIncludePaths.forEach(path => {
        const arg = '-extra-arg=-I' + path;
        configuration.genArgs.push(arg);
      });
    }
  }


  return configuration;
}
