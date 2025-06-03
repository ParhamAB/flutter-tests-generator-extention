import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

interface UseCaseInfo {
  usecase_name: string;
  usecase_file_name: string;
  repository: string;
  repository_method: string;
  param_type: string;
  return_type: string;
}

interface UseCasesData {
  usecases: UseCaseInfo[];
}

class UseCaseTestGeneratorModule {
  private projectName: string = "";

  private parseUseCaseClass(
    line: string
  ): [string | null, string | null, string | null] {
    const classRegex =
      /class (\w+) extends (TUseCase|TPUseCase)<([\w<>]+)(?:, (\w+))?> {/;
    const match = line.match(classRegex);
    if (match) {
      const [, usecaseName, , returnType, paramType] = match;
      return [usecaseName, returnType, paramType || null];
    }
    return [null, null, null];
  }

  private parseRepositoryCall(line: string): [string | null, string | null] {
    const repoRegex = /getIt<(\w+)>\(\)\.(\w+)\(/;
    const match = line.match(repoRegex);
    if (match) {
      const [, repository, repositoryMethod] = match;
      return [repository, repositoryMethod];
    }
    return [null, null];
  }

  private parseParamType(line: string): string | null {
    const paramRegex = /\(([\w\s]+)\)/;
    const match = line.match(paramRegex);
    if (match) {
      return match[1].trim();
    }
    return null;
  }

  private processUseCaseFile(filePath: string): UseCaseInfo | null {
    let usecaseName: string | null = null;
    let returnType: string | null = null;
    let repository: string | null = null;
    let repositoryMethod: string | null = null;
    let paramType: string | null = null;

    const fileContent = fs.readFileSync(filePath, "utf-8");
    const lines = fileContent.split("\n");
    let temp = "";

    for (const line of lines) {
      if (!line.includes("import") && !line.includes("@override")) {
        temp += (temp.endsWith("<") ? "" : " ") + line.trim();

        if (
          temp.includes("class") &&
          (temp.includes("extends TUseCase") ||
            temp.includes("extends TPUseCase")) &&
          temp.endsWith("{")
        ) {
          const [parsedUsecaseName, parsedReturnType, parsedParamType] =
            this.parseUseCaseClass(temp);
          usecaseName = parsedUsecaseName;
          returnType = parsedReturnType;
          paramType = parsedParamType;
          temp = "";
        }

        if (temp.includes("getIt<")) {
          const [parsedRepository, parsedRepositoryMethod] =
            this.parseRepositoryCall(temp);
          repository = parsedRepository;
          repositoryMethod = parsedRepositoryMethod;
        }
      }
    }

    if (usecaseName && repository && repositoryMethod) {
      return {
        usecase_name: usecaseName,
        usecase_file_name: path.basename(filePath).replace(".dart", ""),
        repository,
        repository_method: repositoryMethod,
        param_type: paramType || "",
        return_type: returnType || "",
      };
    }
    return null;
  }

  private findUseCaseFiles(directory: string): string[] {
    const usecaseFiles: string[] = [];

    const walkDir = (dir: string) => {
      const files = fs.readdirSync(dir);
      for (const file of files) {
        const filePath = path.join(dir, file);
        const stat = fs.statSync(filePath);

        if (stat.isDirectory()) {
          walkDir(filePath);
        } else if (
          file.endsWith(".dart") &&
          (file.toLowerCase().includes("use_case") ||
            file.toLowerCase().includes("usecase"))
        ) {
          usecaseFiles.push(filePath);
        }
      }
    };

    walkDir(directory);
    return usecaseFiles;
  }

  private processProjectLibUseCase(directory: string): UseCasesData {
    const libFolder = path.join(directory, "lib");
    const usecases: UseCaseInfo[] = [];
    const usecaseFiles = this.findUseCaseFiles(libFolder);

    for (const filePath of usecaseFiles) {
      const usecaseData = this.processUseCaseFile(filePath);
      if (usecaseData) {
        usecases.push(usecaseData);
      }
    }

    return { usecases };
  }

  private extractUseCaseMethods(
    jsonData: UseCasesData,
    usecaseFileName: string
  ): UseCaseInfo | null {
    const usecaseName = usecaseFileName.replace(".dart", "");

    for (const usecase of jsonData.usecases) {
      if (usecase.usecase_file_name === usecaseName) {
        return usecase;
      }
    }

    return null;
  }

  private generateUseCaseTest(
    usecaseInfo: UseCaseInfo,
    importPath: string
  ): string {
    const usecaseName = usecaseInfo.usecase_name;
    const repository = usecaseInfo.repository;
    const repositoryMethod = usecaseInfo.repository_method;
    const paramType = usecaseInfo.param_type;
    const returnType = usecaseInfo.return_type;

    let testCode = `import 'package:flutter_test/flutter_test.dart';
import 'package:mockito/mockito.dart';
import '${importPath}';
import 'package:${this.projectName}/core/utils/data_states.dart';
import 'package:${this.projectName}/configs/di.dart';

import '../../../../mocked/mocked_data_test.mocks.dart';

void main() {
  late Mock${repository} mock${repository};
  late ${usecaseName} ${usecaseName.toLowerCase()};

  setUp(() {
    mock${repository} = Mock${repository}();
    ${usecaseName.toLowerCase()} = ${usecaseName}();
    getIt.registerFactory<${repository}>(() => mock${repository});
  });

  tearDown(() {
    getIt.reset();
  });

  group('${usecaseName} tests', () {
`;

    if (paramType) {
      testCode += `
    test('should return DataSuccess when repository call is successful', () async {
      final param = ${paramType}();
      final expectedResponse = DataSuccess(true);

      when(mock${repository}.${repositoryMethod}(param))
          .thenAnswer((_) async => expectedResponse);

      final result = await ${usecaseName.toLowerCase()}.call(param);

      expect(result, isA<DataSuccess>());
      verify(mock${repository}.${repositoryMethod}(param)).called(1);
    });
`;
    } else {
      testCode += `
    test('should return DataSuccess when repository call is successful', () async {
      final expectedResponse = DataSuccess(true);

      when(mock${repository}.${repositoryMethod}())
          .thenAnswer((_) async => expectedResponse);

      final result = await ${usecaseName.toLowerCase()}.call();

      expect(result, isA<DataSuccess>());
      verify(mock${repository}.${repositoryMethod}()).called(1);
    });
`;
    }

    testCode += `
    test('should return DataError when repository call fails', () async {
      final expectedResponse = DataError('Error');
`;

    if (paramType) {
      testCode += `
      final param = ${paramType}();
      when(mock${repository}.${repositoryMethod}(param))
          .thenAnswer((_) async => expectedResponse);

      final result = await ${usecaseName.toLowerCase()}.call(param);
`;
    } else {
      testCode += `
      when(mock${repository}.${repositoryMethod}())
          .thenAnswer((_) async => expectedResponse);

      final result = await ${usecaseName.toLowerCase()}.call();
`;
    }

    testCode += `
      expect(result, isA<DataError>());
      verify(mock${repository}.${repositoryMethod}()).called(1);
    });
`;

    testCode += "  });\n}\n";
    return testCode;
  }

  private getWorkspaceRoot(): string | null {
    if (
      vscode.workspace.workspaceFolders &&
      vscode.workspace.workspaceFolders.length > 0
    ) {
      return vscode.workspace.workspaceFolders[0].uri.fsPath;
    }
    return null;
  }

  private getLibPath(): string | null {
    const workspaceRoot = this.getWorkspaceRoot();
    if (!workspaceRoot) return null;

    const libPath = path.join(workspaceRoot, "lib");
    return fs.existsSync(libPath) ? libPath : null;
  }

  private getTestPath(): string | null {
    const workspaceRoot = this.getWorkspaceRoot();
    if (!workspaceRoot) return null;

    const testPath = path.join(workspaceRoot, "test");
    return testPath;
  }

  generateTestsForPath(targetPath: string): void {
    const workspaceRoot = this.getWorkspaceRoot();
    const libPath = this.getLibPath();
    const testPath = this.getTestPath();

    if (!workspaceRoot || !libPath || !testPath) {
      vscode.window.showErrorMessage("Could not find workspace or lib folder");
      return;
    }

    const usecasesJson = this.processProjectLibUseCase(workspaceRoot);
    const stat = fs.statSync(targetPath);

    if (stat.isFile()) {
      const fileName = path.basename(targetPath);
      if (
        fileName.endsWith(".dart") &&
        (fileName.toLowerCase().includes("use_case") ||
          fileName.toLowerCase().includes("usecase"))
      ) {
        this.generateTestForFile(targetPath, libPath, testPath, usecasesJson);
      }
    } else if (stat.isDirectory()) {
      this.generateTestsForDirectory(
        targetPath,
        libPath,
        testPath,
        usecasesJson
      );
    }
  }

  private generateTestForFile(
    filePath: string,
    libPath: string,
    testPath: string,
    usecasesJson: UseCasesData
  ): void {
    const fileName = path.basename(filePath);
    const usecaseInfo = this.extractUseCaseMethods(usecasesJson, fileName);

    if (usecaseInfo) {
      const relativePath = path.relative(libPath, path.dirname(filePath));
      const testDirPath = path.join(testPath, relativePath);

      if (!fs.existsSync(testDirPath)) {
        fs.mkdirSync(testDirPath, { recursive: true });
      }

      const importPath = `package:${this.projectName}/${relativePath.replace(
        /\\/g,
        "/"
      )}/${fileName}`;
      const testCode = this.generateUseCaseTest(usecaseInfo, importPath);
      const testFileName = `${fileName.replace(".dart", "")}_test.dart`;
      const testFilePath = path.join(testDirPath, testFileName);

      if (!fs.existsSync(testFilePath)) {
        fs.writeFileSync(testFilePath, testCode);
        vscode.window.showInformationMessage(
          `Test created for ${testFileName}`
        );
      } else {
        vscode.window.showWarningMessage(
          `Test file for ${testFileName} already exists`
        );
      }
    }
  }

  private generateTestsForDirectory(
    dirPath: string,
    libPath: string,
    testPath: string,
    usecasesJson: UseCasesData
  ): void {
    const files = fs.readdirSync(dirPath);
    let testsGenerated = 0;

    for (const file of files) {
      const filePath = path.join(dirPath, file);
      const stat = fs.statSync(filePath);

      if (
        stat.isFile() &&
        file.endsWith(".dart") &&
        (file.toLowerCase().includes("use_case") ||
          file.toLowerCase().includes("usecase"))
      ) {
        this.generateTestForFile(filePath, libPath, testPath, usecasesJson);
        testsGenerated++;
      } else if (stat.isDirectory()) {
        this.generateTestsForDirectory(
          filePath,
          libPath,
          testPath,
          usecasesJson
        );
      }
    }

    if (testsGenerated > 0) {
      vscode.window.showInformationMessage(
        `Generated ${testsGenerated} test files`
      );
    }
  }
}

export async function registerUseCaseTestGeneratorModule(
  context: vscode.ExtensionContext
): Promise<void> {
  const disposable = vscode.commands.registerCommand(
    "extension.generateUseCaseTest",
    (uri: vscode.Uri) => {
      if (uri && uri.fsPath) {
        const generator = new UseCaseTestGeneratorModule();
        generator.generateTestsForPath(uri.fsPath);
      } else {
        vscode.window.showErrorMessage(
          "Please right-click on a file or folder"
        );
      }
    }
  );

  context.subscriptions.push(disposable);
}
