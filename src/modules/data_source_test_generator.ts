import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { getAllModels } from "../utils/model_utils";
import { getTestValue } from "./models_test_generator";

interface InnerType {
  name: string;
  type: string;
}

interface MethodInfo {
  method_name: string;
  return_type: string;
  params: string | null;
  http_method: string | null;
  instance_name: string | null;
  inner_types: InnerType[];
}

interface DataSource {
  data_source_name: string;
  data_source_file_name: string;
  methods: MethodInfo[];
  imports: string;
}

class DataSourceTestGenerator {
  private extract_inner_types(paramsString: string | null): InnerType[] {
    if (!paramsString || !paramsString.trim()) {
      return [];
    }

    const innerTypes: InnerType[] = [];
    const paramsList: string[] = [];
    let balance = 0;
    let currentParam = "";
    for (let i = 0; i < paramsString.length; i++) {
      const char = paramsString[i];
      if (char === "<") {
        balance++;
      } else if (char === ">") {
        balance--;
      } else if (char === "," && balance === 0) {
        paramsList.push(currentParam.trim());
        currentParam = "";
        continue;
      }
      currentParam += char;
    }
    paramsList.push(currentParam.trim());

    for (const param of paramsList) {
      if (!param) continue;
      const lastSpaceIndex = param.lastIndexOf(" ");
      if (lastSpaceIndex === -1) {
        // console.warn(`Could not properly parse parameter: ${param}`);
        continue;
      }

      const type = param.substring(0, lastSpaceIndex).trim();
      const name = param.substring(lastSpaceIndex + 1).trim();

      if (type && name) {
        innerTypes.push({ name, type });
      }
    }
    return innerTypes;
  }

  private parse_method_line(
    methodBlock: string
  ): [string | null, string | null, string | null] {
    const signatureEndMatch = methodBlock.match(/\)\s*(async\s*=>|=>|\{)/);
    let signaturePart = methodBlock;
    if (signatureEndMatch && signatureEndMatch.index !== undefined) {
      signaturePart = methodBlock.substring(0, signatureEndMatch.index + 1);
    } else {
      const paramsEndIndex = methodBlock.lastIndexOf(")");
      if (
        paramsEndIndex > 0 &&
        methodBlock
          .substring(paramsEndIndex + 1)
          .trim()
          .startsWith(";")
      ) {
        signaturePart = methodBlock.substring(0, paramsEndIndex + 1);
      } else {
        const firstBrace = methodBlock.indexOf("{");
        if (firstBrace > -1)
          signaturePart = methodBlock.substring(0, firstBrace);
      }
    }

    const openParenIndex = signaturePart.indexOf("(");
    if (openParenIndex === -1) return [null, null, null];

    let closeParenIndex = -1;
    let parenBalance = 0;
    for (let i = openParenIndex; i < signaturePart.length; i++) {
      if (signaturePart[i] === "(") parenBalance++;
      else if (signaturePart[i] === ")") parenBalance--;
      if (parenBalance === 0) {
        closeParenIndex = i;
        break;
      }
    }
    if (closeParenIndex === -1) return [null, null, null];

    const params = signaturePart
      .substring(openParenIndex + 1, closeParenIndex)
      .trim();
    const beforeParams = signaturePart.substring(0, openParenIndex).trim();
    const parts = beforeParams.split(/\s+/);
    if (parts.length < 1) return [null, null, params];

    const methodName = parts.pop() || null;
    const returnType = parts.join(" ").trim() || null;

    return [returnType, methodName, params];
  }

  private parse_http_method(
    instanceName: string | null,
    line: string
  ): [string | null, string | null] {
    const match = line.match(/\.(post|get|put|delete)\(/);
    return match ? [match[1].toUpperCase(), instanceName] : [null, null];
  }

  private extract_instance_name(line: string): string | null {
    const match = line.match(/getIt<Dio>\(instanceName: (\w+)\)/);
    const match2 = line.match(/getIt<Dio>\(instanceName: ['"]([^'"]+)['"]\)/);
    if (match && match[1]) return match[1];
    if (match2 && match2[1]) return match2[1];
    return null;
  }

  private process_file(filePath: string): DataSource | null {
    if (!fs.existsSync(filePath)) {
      return null;
    }

    let dataSourceName: string | null = null;
    const methods: MethodInfo[] = [];
    let currentMethodBlockAccumulator = "";
    let isCapturingMethodBlock = false;
    let canProcessFileContent = false;

    try {
      const content = fs.readFileSync(filePath, "utf-8");
      const imports = content
        .split("\n")
        .filter(
          (line) =>
            line.includes("import") &&
            line.includes("package:") &&
            !line.includes("injectable/injectable") &&
            !line.includes("dio/dio")
        )
        .join("\n");
      const lines = content.split("\n");

      for (const line of lines) {
        const trimmedLine = line.trim();

        if (trimmedLine.includes("abstract class")) {
          const match = trimmedLine.match(/abstract class (\w+)/);
          if (match) dataSourceName = match[1];
          canProcessFileContent = false;
        }

        if (canProcessFileContent) {
          if (trimmedLine.startsWith("@override")) {
            isCapturingMethodBlock = true;
            currentMethodBlockAccumulator = "";
          } else if (isCapturingMethodBlock) {
            if (!trimmedLine && !currentMethodBlockAccumulator) {
              continue;
            }
            currentMethodBlockAccumulator +=
              (currentMethodBlockAccumulator ? " " : "") + trimmedLine;

            if (currentMethodBlockAccumulator.endsWith(";")) {
              const [returnType, methodName, paramsString] =
                this.parse_method_line(currentMethodBlockAccumulator);
              const instanceName = this.extract_instance_name(
                currentMethodBlockAccumulator
              );
              const [httpMethod, _] = this.parse_http_method(
                instanceName,
                currentMethodBlockAccumulator
              );
              const innerTypes = this.extract_inner_types(paramsString);

              if (returnType && methodName) {
                methods.push({
                  method_name: methodName,
                  return_type:
                    returnType && returnType.startsWith("Future<")
                      ? returnType
                          .replace(/^Future<(.+)>$/, "$1")
                          .trim()
                          .replaceAll("?", "")
                      : returnType.replaceAll("?", ""),
                  params: paramsString,
                  http_method: httpMethod,
                  instance_name: instanceName,
                  inner_types: innerTypes,
                });
              }
              isCapturingMethodBlock = false;
              currentMethodBlockAccumulator = "";
            }
          }
        }

        if (trimmedLine.includes("}")) {
          canProcessFileContent = true;
        }
      }

      if (dataSourceName && methods.length) {
        return {
          data_source_name: dataSourceName,
          data_source_file_name: path.basename(filePath).replace(".dart", ""),
          methods,
          imports,
        };
      }
    } catch (error) {
      // console.error(`Error processing file ${filePath}:`, error);
    }
    return null;
  }

  private find_data_source_files(directory: string): string[] {
    const files: string[] = [];
    const walk = (dir: string) => {
      try {
        if (!fs.existsSync(dir)) return;
        fs.readdirSync(dir).forEach((file) => {
          const fullPath = path.join(dir, file);
          try {
            if (fs.statSync(fullPath).isDirectory()) {
              walk(fullPath);
            } else if (
              file.toLowerCase().includes("data_source") &&
              file.endsWith(".dart")
            ) {
              files.push(fullPath);
            }
          } catch (error) {
            // console.error(`Error processing ${fullPath}:`, error);
          }
        });
      } catch (error) {
        // console.error(`Error reading directory ${dir}:`, error);
      }
    };
    walk(directory);
    return files;
  }

  // This is the new generateMethodParams function you provided.
  // Ensure getAllModels and getTestValue are accessible in this scope.
  private generateMethodParams(innerTypes: InnerType[]): string {
    if (!innerTypes || innerTypes.length === 0) return "";
    return innerTypes
      .map((param) => {
        const cleanParamName = param.name.replace(/[{}]/g, "");
        const paramType = param.type.toLowerCase();
        if (paramType.includes("string")) return `'test_${cleanParamName}'`;
        if (paramType.includes("int")) return "1";
        if (paramType.includes("bool")) return "true";
        if (paramType.includes("double")) return "1.0";
        if (paramType.includes("num")) return "1";
        if (paramType.startsWith("list<")) return "[]";
        if (paramType.startsWith("map<")) return `{"test" : "test"}`;
        let models = getAllModels(); // Needs actual implementation
        let selectedClass = models.find(
          (el) => el.modelName == param.type.replace("?", "")
        );
        if (selectedClass !== null && selectedClass !== undefined) {
          let fieldLines = Object.entries(selectedClass!.fields)
            .map(
              ([fieldName, fieldType]) =>
                `${fieldName}: ${getTestValue(fieldType, models)}` // Passed models here
            )
            .join(", ");
          return `${selectedClass.modelName}(${fieldLines})`;
        }
        return `${param.type.replace("?", "")}()`;
      })
      .join(", ");
  }

  private generateMethodTestBlock(
    method: MethodInfo,
    dataSourceName: string,
    projectPackageName: string = "your_project_name"
  ): string {
    const methodName = method.method_name;
    const returnType = method.return_type || "dynamic";
    const httpMethod = method.http_method?.toLowerCase() || "get";

    let methodBlockContent = `//***${methodName}-START***//
    group('${methodName}', () {
      test('should return ${returnType} when ${httpMethod.toUpperCase()} request is successful', () async {
        final expectedData = <String, dynamic>{};
        when(mockDio.${httpMethod}(any, data: anyNamed('data'), queryParameters: anyNamed('queryParameters')))
            .thenAnswer((_) async => Response(
                  data: expectedData,
                  statusCode: 200,
                  requestOptions: RequestOptions(path: ''),
                ));

        final result = await dataSource.${methodName}(${this.generateMethodParams(
      method.inner_types
    )});

        expect(result, isA<${returnType}>());
      });

      test('should throw exception when ${httpMethod.toUpperCase()} request fails', () async {
        when(mockDio.${httpMethod}(any, data: anyNamed('data'), queryParameters: anyNamed('queryParameters')))
            .thenThrow(DioException(
              requestOptions: RequestOptions(path: ''),
              error: 'Network error',
            ));

        expect(
          () async => await dataSource.${methodName}(${this.generateMethodParams(
      method.inner_types
    )}),
          throwsA(isA<DioException>()),
        );
      });
    });
//***${methodName}-END***//`;
    return methodBlockContent;
  }

  private generateInitialTestFileContent(
    dataSource: DataSource,
    projectPackageName: string = "your_project_name",
    relativePathFromLib: string
  ): string {
    const className = dataSource.data_source_name;
    const dataSourceFileName = dataSource.data_source_file_name;
    const concreteClassName = className.startsWith("I")
      ? className.substring(1)
      : className;
    const featureNameGuess = dataSourceFileName
      .split("_data_source")[0]
      .toLowerCase();

    // Collect all unique instance names from methods
    const uniqueInstanceNames = Array.from(
      new Set(
        dataSource.methods
          .map((m) => m.instance_name)
          .filter((name): name is string => !!name)
      )
    );

    // Generate getIt.registerSingleton lines for each unique instance name
    const registerSingletonLines = uniqueInstanceNames
      .map(
        (instanceName) =>
          `getIt.registerSingleton<Dio>(mockDio, instanceName: ${instanceName});`
      )
      .join("\n      ");

    let initialContent = `import 'package:flutter_test/flutter_test.dart';
import 'package:mockito/mockito.dart';
import 'package:dio/dio.dart';
import 'package:${projectPackageName}/${relativePathFromLib}';
${dataSource.imports
  .split("\n")
  .filter((el) => !el.includes("injectable") || !el.includes("dio/dio"))
  .join("\n")}
//***IMPORTS***//


void main() {
  group('${concreteClassName}', () {
    late MockDio mockDio;
    late ${concreteClassName} dataSource;

    setUp(() {
      mockDio = MockDio();
      dataSource = ${concreteClassName}();
      ${registerSingletonLines}
    });

    tearDown((){
      getIt.reset();
    });

`;
    for (const method of dataSource.methods) {
      initialContent += this.generateMethodTestBlock(
        method,
        dataSource.data_source_name,
        projectPackageName
      );
      initialContent += "\n\n";
    }

    initialContent += `    //***LAST-LINE***//
  });
}
`;
    return initialContent;
  }

  private async createTestFile(
    dataSource: DataSource,
    originalFilePath: string,
    rootPath: string,
    libDirName: string = "lib",
    testDirName: string = "test",
    projectPackageName: string = "your_project_name"
  ): Promise<string> {
    const relativePathFromLib = path.relative(
      path.join(rootPath, libDirName),
      path.dirname(originalFilePath)
    );
    const targetTestDirectory = path.join(
      rootPath,
      testDirName,
      relativePathFromLib
    );
    const testFileName = `${dataSource.data_source_file_name}_test.dart`;
    const testFilePath = path.join(targetTestDirectory, testFileName);
    const concreteClassName = dataSource.data_source_name.startsWith("I")
      ? dataSource.data_source_name.substring(1)
      : dataSource.data_source_name;
    const featureNameGuess = dataSource.data_source_file_name
      .split("_data_source")[0]
      .toLowerCase();

    try {
      if (!fs.existsSync(targetTestDirectory)) {
        fs.mkdirSync(targetTestDirectory, { recursive: true });
      }

      if (fs.existsSync(testFilePath)) {
        let existingContent = fs.readFileSync(testFilePath, "utf-8");
        let contentModified = false;

        const importsMarker = "//***IMPORTS***//";

        if (existingContent.includes(importsMarker)) {
          existingContent = existingContent.replace(
            importsMarker,
            `${dataSource.imports
              .split("\n")
              .filter((el) => !existingContent.includes(el))
              .join("\n")}\n${importsMarker}`
          );
          contentModified = true;
        }

        const setUpRegex = new RegExp(
          `setUp\\(\s*\\(\s*\\)\\s*=>\\s*{\\s*mockDio\\s*=\\s*MockDio\\(\\s*\\);\\s*dataSource\\s*=\\s*${concreteClassName}\\(mockDio\\);\\s*}\\);`
        );
        if (!setUpRegex.test(existingContent)) {
          const groupLineRegex = new RegExp(
            `group\\(\\s*'${concreteClassName}'\\s*,\\s*\\(\\s*\\)\\s*=>\\s*{`
          );
          const newSetupBlock = `
    late MockDio mockDio;
    late ${concreteClassName} dataSource;

    setUp(() {
      mockDio = MockDio();
      dataSource = ${concreteClassName}(mockDio);
    });`;
          if (groupLineRegex.test(existingContent)) {
            existingContent = existingContent.replace(
              groupLineRegex,
              `group('${concreteClassName}', () {${newSetupBlock}`
            );
            contentModified = true;
          }
        }

        let newMethodBlocksCombined = "";
        for (const method of dataSource.methods) {
          const startMarker = `//***${method.method_name}-START***//`;
          if (!existingContent.includes(startMarker)) {
            newMethodBlocksCombined +=
              this.generateMethodTestBlock(
                method,
                dataSource.data_source_name,
                projectPackageName
              ) + "\n\n";
            contentModified = true;
          }
        }

        const lastLineMarker = "//***LAST-LINE***//";
        if (newMethodBlocksCombined) {
          if (existingContent.includes(lastLineMarker)) {
            existingContent = existingContent.replace(
              lastLineMarker,
              newMethodBlocksCombined.trimEnd() + "\n    " + lastLineMarker
            );
          } else {
            const mainGroupEndPattern = /}\s*\);\s*$/;
            const match = existingContent.match(mainGroupEndPattern);
            if (match && match.index !== undefined) {
              existingContent =
                existingContent.substring(0, match.index) +
                `\n${newMethodBlocksCombined.trimEnd()}\n    ${lastLineMarker}\n});`;
              contentModified = true;
            }
          }
        }

        if (contentModified) {
          fs.writeFileSync(testFilePath, existingContent, "utf-8");
        }
      } else {
        let initialContent = this.generateInitialTestFileContent(
          dataSource,
          projectPackageName,
          `${relativePathFromLib}/${originalFilePath.split("/").pop() ?? ""}`
        );
        fs.writeFileSync(testFilePath, initialContent, "utf-8");
      }
      return testFilePath;
    } catch (error: any) {
      // vscode.window.showErrorMessage(`Failed to create/update test file at ${testFilePath}: ${error.message}`);
      throw new Error(
        `Failed to create/update test file at ${testFilePath}: ${error.message}`
      );
    }
  }

  public async generateTestsForPath(resourcePath: string): Promise<void> {
    try {
      const stat = fs.statSync(resourcePath);
      const workspaceFolder = vscode.workspace.getWorkspaceFolder(
        vscode.Uri.file(resourcePath)
      );

      if (!workspaceFolder) {
        // vscode.window.showErrorMessage('No workspace folder found for the selected resource.');
        return;
      }

      const rootPath = workspaceFolder.uri.fsPath;
      const libDirName = "lib";
      const testDirName = "test";
      let projectPackageName = "your_project_name";

      try {
        const pubspecPath = path.join(rootPath, "pubspec.yaml");
        if (fs.existsSync(pubspecPath)) {
          const pubspecContent = fs.readFileSync(pubspecPath, "utf-8");
          const match = pubspecContent.match(/^name:\s*(\S+)/m);
          if (match && match[1]) {
            projectPackageName = match[1];
          }
        }
      } catch (e) {
        console.error("Could not read project name from pubspec.yaml", e);
      }

      let filesToProcess: string[] = [];

      if (stat.isDirectory()) {
        if (!resourcePath.includes(path.join(rootPath, libDirName)) && resourcePath !== path.join(rootPath, libDirName)) {
             vscode.window.showWarningMessage(`Selected directory might not be inside the '${libDirName}' folder. Ensure data sources are within '${libDirName}'.`);
        }
        filesToProcess = this.find_data_source_files(resourcePath);
      } else if (
        stat.isFile() &&
        resourcePath.toLowerCase().includes("data_source") &&
        resourcePath.endsWith(".dart")
      ) {
        if (!path.dirname(resourcePath).includes(path.join(rootPath, libDirName))) {
             vscode.window.showWarningMessage(`Selected file might not be inside the '${libDirName}' folder. Ensure data source is within '${libDirName}'.`);
        }
        filesToProcess = [resourcePath];
      } else {
        // vscode.window.showInformationMessage('Selected resource is not a directory or a Dart data source file.');
        return;
      }

      if (filesToProcess.length === 0) {
        // vscode.window.showInformationMessage('No data source files found in the selected location.');
        return;
      }

      const createdFiles: string[] = [];
      let firstTestDirectory: string | null = null;

      for (const filePath of filesToProcess) {
        const dataSource = this.process_file(filePath);
        if (dataSource) {
          try {
            const libPath = path.join(rootPath, libDirName);
            let relativeDir = "";
            if (filePath.startsWith(libPath)) {
              relativeDir = path.relative(libPath, path.dirname(filePath));
            } else {
              relativeDir = path.relative(rootPath, path.dirname(filePath));
            }
            const targetTestDir = path.join(rootPath, testDirName, relativeDir);
            if (!firstTestDirectory) {
              firstTestDirectory = targetTestDir;
            }
            const testFilePath = await this.createTestFile(
              dataSource,
              filePath,
              rootPath,
              libDirName,
              testDirName,
              projectPackageName
            );
            createdFiles.push(testFilePath);
          } catch (error: any) {
            // console.error(`Error creating test for ${dataSource.data_source_name}:`, error.message);
            // vscode.window.showErrorMessage(`Failed to create test for ${dataSource.data_source_name}: ${error.message}`);
          }
        }
      }

      if (createdFiles.length > 0) {
        const message = `Generated ${createdFiles.length} test file(s).`;
        // const openTestAction = 'Open First Test';
        // const openFolderAction = 'Reveal Test Folder';

        // let chosenAction: string | undefined;
        // if (createdFiles.length === 1 && firstTestDirectory) {
        //      chosenAction = await vscode.window.showInformationMessage(message, openTestAction, openFolderAction);
        // } else if (firstTestDirectory) {
        //      chosenAction = await vscode.window.showInformationMessage(message, openFolderAction);
        // } else {
        //      vscode.window.showInformationMessage(message);
        // }

        // if (chosenAction === openFolderAction && firstTestDirectory) {
        //     const testFolderUri = vscode.Uri.file(firstTestDirectory);
        //     await vscode.commands.executeCommand('revealInExplorer', testFolderUri);
        // } else if (chosenAction === openTestAction && createdFiles.length > 0) {
        //     const document = await vscode.workspace.openTextDocument(createdFiles[0]);
        //     await vscode.window.showTextDocument(document);
        // }
        vscode.window.showInformationMessage(message);
      }
    } catch (error: any) {
      // console.error('Error generating tests:', error.message);
      // vscode.window.showErrorMessage(`Error generating tests: ${error.message}`);
    }
  }
}

async function generateDataSourceTest(uri?: vscode.Uri) {
  let resourceUri = uri;
  if (!resourceUri) {
    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor && activeEditor.document.uri.scheme === "file") {
      resourceUri = activeEditor.document.uri;
    } else {
      // vscode.window.showErrorMessage('Please select a file or folder in the explorer or open a data source file to generate tests.');
      return;
    }
  }
  const generator = new DataSourceTestGenerator();
  await generator.generateTestsForPath(resourceUri.fsPath);
}

export async function registerDataSourceGeneratorModule(
  context: vscode.ExtensionContext
): Promise<void> {
  const disposable = vscode.commands.registerCommand(
    "extension.generateDataSourceTest",
    generateDataSourceTest
  );
  context.subscriptions.push(disposable);
}
