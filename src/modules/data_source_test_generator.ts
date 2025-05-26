import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { getAllModels } from "../utils/model_utils";
import { getTestValue } from "./models_test_generator";

// Assuming ModelInfo is defined in one of the imported files or globally
// If not, you might need to define/import it:
// interface ModelInfo {
//   modelName: string;
//   fields: Record<string, string>;
//   importPath: string;
//   hasToJson?: boolean;
//   hasFromJson?: boolean;
// }

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
  imports: string; // Imports from the source data source file
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
    let importsData = "";

    try {
      const content = fs.readFileSync(filePath, "utf-8");
      importsData = content // Store all imports from the source file
        .split("\n")
        .filter((line) => line.trim().startsWith("import "))
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
                      : (returnType || "").replaceAll("?", ""), // Ensure returnType is not null
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
          imports: importsData, // Use all captured imports
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
        let models = getAllModels();
        let selectedClass = models.find(
          (el) => el.modelName == param.type.replace("?", "")
        );
        if (selectedClass !== null && selectedClass !== undefined) {
          let fieldLines = Object.entries(selectedClass!.fields)
            .map(
              ([fieldName, fieldType]) =>
                `${fieldName}: ${getTestValue(fieldType, models)}`
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
    dataSourceName: string, // This parameter seems unused, can be removed if not needed elsewhere
    projectPackageName: string = "your_project_name" // Also seems unused here
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

  private findAllMockFileImports(
    newTestFileDir: string,
    projectTestRoot: string,
    currentTestSpecificMockFileName: string
  ): string {
    const mockImportStatements: string[] = [];
    const allFilesAndFolders = fs.readdirSync(projectTestRoot, {
      withFileTypes: true,
    });

    const findMocksRecursive = (currentDir: string) => {
      const items = fs.readdirSync(currentDir, { withFileTypes: true });
      for (const item of items) {
        const fullPath = path.join(currentDir, item.name);
        if (item.isDirectory()) {
          findMocksRecursive(fullPath);
        } else if (
          item.name.endsWith(".mocks.dart") &&
          item.name !== currentTestSpecificMockFileName
        ) {
          let relativePath = path.relative(newTestFileDir, fullPath);
          relativePath = relativePath.replace(/\\/g, "/"); // Ensure forward slashes
          mockImportStatements.push(`import '${relativePath}';`);
        }
      }
    };

    findMocksRecursive(projectTestRoot);
    return mockImportStatements.join("\n");
  }

  private generateInitialTestFileContent(
    dataSource: DataSource,
    projectPackageName: string = "your_project_name",
    relativePathToOriginalDataSourceFile: string, // e.g. 'feature_x/data/datasources/my_data_source.dart'
    additionalMockImports: string
  ): string {
    const className = dataSource.data_source_name;
    const dataSourceFileName = dataSource.data_source_file_name;
    const concreteClassName = className.startsWith("I")
      ? className.substring(1)
      : className;

    const uniqueInstanceNames = Array.from(
      new Set(
        dataSource.methods
          .map((m) => m.instance_name)
          .filter((name): name is string => !!name)
      )
    );

    const registerSingletonLines = uniqueInstanceNames
      .map(
        (instanceName) =>
          `      getIt.registerSingleton<Dio>(mockDio, instanceName: ${instanceName});`
      )
      .join("\n");


    // Filter dataSource.imports: remove dio, injectable, and already existing standard imports
    const specificDataSourcePackageImports = dataSource.imports
      .split("\n")
      .filter(
        (line) => line.trim().startsWith("import ") && line.includes("package:")
      )
      .filter(
        (line) =>
          !line.includes("package:dio/") &&
          !line.includes("package:injectable/") &&
          !line.includes("package:flutter_test/") &&
          !line.includes("package:mockito/")
      )
      .join("\n");

    let initialContent = `import 'package:flutter_test/flutter_test.dart';
import 'package:mockito/mockito.dart';
import 'package:dio/dio.dart';
import 'package:get_it/get_it.dart';
import 'package:${projectPackageName}/${relativePathToOriginalDataSourceFile.replace(
      /\\/g,
      "/"
    )}';
${specificDataSourcePackageImports}
//***IMPORTS***//

${additionalMockImports}

void main() {
  group('${concreteClassName}', () {
    late MockDio mockDio;
    late ${concreteClassName} dataSource;

    setUp(() {
      mockDio = MockDio();
      ${registerSingletonLines}
      dataSource = ${concreteClassName}();
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
    originalFilePath: string, // Full path to the original .dart data source file
    rootPath: string, // Workspace root path
    libDirName: string = "lib",
    testDirName: string = "test",
    projectPackageName: string = "your_project_name"
  ): Promise<string> {
    // Relative path of the original file from project_root/lib
    const relativePathFromLibToOriginalFile = path.relative(
      path.join(rootPath, libDirName),
      originalFilePath
    );
    // Directory for the new test file, mirroring the structure from lib to test
    const targetTestDirectory = path.join(
      rootPath,
      testDirName,
      path.dirname(relativePathFromLibToOriginalFile)
    );

    const testFileName = `${dataSource.data_source_file_name}_test.dart`;
    const testFilePath = path.join(targetTestDirectory, testFileName);
    const concreteClassName = dataSource.data_source_name.startsWith("I")
      ? dataSource.data_source_name.substring(1)
      : dataSource.data_source_name;

    try {
      if (!fs.existsSync(targetTestDirectory)) {
        fs.mkdirSync(targetTestDirectory, { recursive: true });
      }

      const projectTestRoot = path.join(rootPath, testDirName);
      const currentTestSpecificMockFileName = `${dataSource.data_source_file_name}_test.mocks.dart`;

      if (fs.existsSync(testFilePath)) {
        let existingContent = fs.readFileSync(testFilePath, "utf-8");
        let contentModified = false;

        const importsMarker = "//***IMPORTS***//";
        const additionalMockImports = this.findAllMockFileImports(
          targetTestDirectory,
          projectTestRoot,
          currentTestSpecificMockFileName
        );
        let combinedNewImports = additionalMockImports;

        const specificDataSourcePackageImports = dataSource.imports
          .split("\n")
          .filter(
            (line) =>
              line.trim().startsWith("import ") && line.includes("package:")
          )
          .filter(
            (line) =>
              !line.includes("package:dio/") &&
              !line.includes("package:injectable/") &&
              !line.includes("package:flutter_test/") &&
              !line.includes("package:mockito/")
          )
          .filter((line) => !existingContent.includes(line.trim())) // Only new imports
          .join("\n");

        if (specificDataSourcePackageImports) {
          combinedNewImports +=
            (combinedNewImports ? "\n" : "") + specificDataSourcePackageImports;
        }

        if (existingContent.includes(importsMarker)) {
          if (combinedNewImports) {
            existingContent = existingContent.replace(
              importsMarker,
              `${combinedNewImports}\n${importsMarker}`
            );
            contentModified = true;
          }
        } else {
          const generateMocksLine = `@GenerateMocks([Dio])`;
          const generateMocksIndex = existingContent.indexOf(generateMocksLine);
          if (generateMocksIndex !== -1) {
            const beforeGenerateMocks = existingContent.substring(
              0,
              generateMocksIndex
            );
            const afterGenerateMocks =
              existingContent.substring(generateMocksIndex);
            existingContent = `${beforeGenerateMocks}${importsMarker}\n${afterGenerateMocks}`;
            if (combinedNewImports) {
              existingContent = existingContent.replace(
                importsMarker,
                `${combinedNewImports}\n${importsMarker}`
              );
            }
            contentModified = true;
          }
        }

        const uniqueInstanceNames = Array.from(
          new Set(
            dataSource.methods
              .map((m) => m.instance_name)
              .filter((name): name is string => !!name)
          )
        );

        const registerSingletonLines = uniqueInstanceNames
          .map(
            (instanceName) =>
              `      getIt.registerSingleton<Dio>(mockDio, instanceName: "${instanceName}");`
          )
          .join("\n");

        const tearDownInstanceNames = uniqueInstanceNames
          .map(
            (instanceName) =>
              `      getIt.unregister<Dio>(instanceName: "${instanceName}");`
          )
          .join("\n");

        const setUpFindRegex = /setUp\(\s*\(\)\s*=>\s*\{/;
        let setUpMatch = existingContent.match(setUpFindRegex);
        if (setUpMatch && setUpMatch.index !== undefined) {
          let endOfSetUp = existingContent.indexOf("});", setUpMatch.index);
          if (endOfSetUp !== -1) {
            let setUpBlock = existingContent.substring(
              setUpMatch.index,
              endOfSetUp + 3
            );
            let newRegisterLines = "";
            uniqueInstanceNames.forEach((instName) => {
              if (!setUpBlock.includes(`instanceName: "${instName}"`)) {
                newRegisterLines += `\n      getIt.registerSingleton<Dio>(mockDio, instanceName: "${instName}");`;
              }
            });
            if (newRegisterLines) {
              const dataSourceLineIndex = setUpBlock.indexOf(
                `dataSource = ${concreteClassName}`
              );
              if (dataSourceLineIndex !== -1) {
                const beforeDataSource = setUpBlock.substring(
                  0,
                  dataSourceLineIndex
                );
                const afterDataSource =
                  setUpBlock.substring(dataSourceLineIndex);
                const modifiedSetupBlock =
                  beforeDataSource +
                  newRegisterLines +
                  "\n      " +
                  afterDataSource;
                existingContent = existingContent.replace(
                  setUpBlock,
                  modifiedSetupBlock
                );
                contentModified = true;
              }
            }
          }
        } else {
          // If setUp block doesn't exist, add it
          const groupLineRegex = new RegExp(
            `group\\(\\s*'${concreteClassName}'\\s*,\\s*\\(\\s*\\)\\s*=>\\s*{`
          );
          const newSetupAndTearDown = `
    late MockDio mockDio;
    late ${concreteClassName} dataSource;

    setUp(() {
      mockDio = MockDio();
${registerSingletonLines}
      dataSource = ${concreteClassName}();
    });

    tearDown((){
${tearDownInstanceNames}
      getIt.reset();
    });`;
          if (groupLineRegex.test(existingContent)) {
            existingContent = existingContent.replace(
              groupLineRegex,
              `group('${concreteClassName}', () {${newSetupAndTearDown}`
            );
            contentModified = true;
          }
        }

        const tearDownFindRegex = /tearDown\(\s*\(\)\s*=>\s*\{/;
        let tearDownMatch = existingContent.match(tearDownFindRegex);
        if (tearDownMatch && tearDownMatch.index !== undefined) {
          let endOfTearDown = existingContent.indexOf(
            "});",
            tearDownMatch.index
          );
          if (endOfTearDown !== -1) {
            let tearDownBlock = existingContent.substring(
              tearDownMatch.index,
              endOfTearDown + 3
            );
            let newUnregisterLines = "";
            uniqueInstanceNames.forEach((instName) => {
              if (!tearDownBlock.includes(`instanceName: "${instName}"`)) {
                newUnregisterLines += `\n      getIt.unregister<Dio>(instanceName: "${instName}");`;
              }
            });
            if (newUnregisterLines) {
              const resetLineIndex = tearDownBlock.indexOf(`getIt.reset();`);
              if (resetLineIndex !== -1) {
                const beforeReset = tearDownBlock.substring(0, resetLineIndex);
                const afterReset = tearDownBlock.substring(resetLineIndex);
                const modifiedTearDownBlock =
                  beforeReset + newUnregisterLines + "\n      " + afterReset;
                existingContent = existingContent.replace(
                  tearDownBlock,
                  modifiedTearDownBlock
                );
                contentModified = true;
              }
            }
          }
        }

        let newMethodBlocksCombined = "";
        for (const method of dataSource.methods) {
          const startMarker = `//***${method.method_name}-START***//`;
          if (!existingContent.includes(startMarker)) {
            newMethodBlocksCombined +=
              this.generateMethodTestBlock(
                method,
                dataSource.data_source_name
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
            const mainGroupEndPattern = /}\s*\);\s*(\n\s*})?\s*$/; // Adjusted to find the end of the main group more reliably
            const match = existingContent.match(mainGroupEndPattern);
            if (match && match.index !== undefined) {
              const endChar = match[1] ? match[1] : ""; // Checks if the final '}' of main was captured
              existingContent =
                existingContent.substring(0, match.index) + // Content before group closing
                `\n${newMethodBlocksCombined.trimEnd()}\n    ${lastLineMarker}\n  });${endChar}`; // Inserted content + marker + group closing
              contentModified = true;
            } else {
              const lastClosingBrace = existingContent.lastIndexOf("}"); // Fallback: find the very last '}'
              if (lastClosingBrace !== -1) {
                const beforeLastBrace = existingContent.substring(
                  0,
                  lastClosingBrace
                );
                const afterLastBrace =
                  existingContent.substring(lastClosingBrace); // Should be '}'
                existingContent =
                  beforeLastBrace +
                  `\n${newMethodBlocksCombined.trimEnd()}\n    ${lastLineMarker}\n  ` +
                  afterLastBrace;
                contentModified = true;
              }
            }
          }
        }

        if (contentModified) {
          fs.writeFileSync(testFilePath, existingContent, "utf-8");
        }
      } else {
        const additionalMockImports = this.findAllMockFileImports(
          targetTestDirectory,
          projectTestRoot,
          currentTestSpecificMockFileName
        );
        let initialContent = this.generateInitialTestFileContent(
          dataSource,
          projectPackageName,
          relativePathFromLibToOriginalFile, // Pass the relative path to the original DS file
          additionalMockImports
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
        // console.error("Could not read project name from pubspec.yaml", e);
      }

      let filesToProcess: string[] = [];

      if (stat.isDirectory()) {
        filesToProcess = this.find_data_source_files(resourcePath);
      } else if (
        stat.isFile() &&
        resourcePath.toLowerCase().includes("data_source") &&
        resourcePath.endsWith(".dart")
      ) {
        filesToProcess = [resourcePath];
      } else {
        return;
      }

      if (filesToProcess.length === 0) {
        return;
      }

      const createdFiles: string[] = [];
      let firstTestDirectory: string | null = null;

      for (const filePath of filesToProcess) {
        const dataSource = this.process_file(filePath);
        if (dataSource) {
          try {
            const libPath = path.join(rootPath, libDirName);
            // originalFilePath is filePath
            const relativeDirFromLib = path.relative(
              libPath,
              path.dirname(filePath)
            );

            const targetTestDir = path.join(
              rootPath,
              testDirName,
              relativeDirFromLib
            );
            if (!firstTestDirectory) {
              firstTestDirectory = targetTestDir;
            }
            const testFilePath = await this.createTestFile(
              dataSource,
              filePath, // Pass originalFilePath here
              rootPath,
              libDirName,
              testDirName,
              projectPackageName
            );
            createdFiles.push(testFilePath);
          } catch (error: any) {
            // console.error(`Error creating test for ${dataSource.data_source_name}:`, error.message);
          }
        }
      }

      if (createdFiles.length > 0) {
        const message = `Generated ${createdFiles.length} test file(s).`;
        vscode.window.showInformationMessage(message);
      }
    } catch (error: any) {
      // console.error('Error generating tests:', error.message);
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
