import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { getAllModels } from "../utils/model_utils"; // Assuming this path is correct
import { getTestValue } from "./models_test_generator"; // Assuming this path is correct

// ModelInfo interface should be defined here or imported if used by getAllModels/getTestValue
interface ModelInfo {
  modelName: string;
  fields: Record<string, string>;
  importPath: string;
  // Add other fields if present in your actual ModelInfo definition
}

interface InnerType {
  // This was from DataSource generator, ensure it's what Repository params need
  name: string;
  type: string;
}

interface RepositoryParamInfo {
  name: string;
  type: string;
  isOptional: boolean;
  isNamed: boolean;
}

interface RepositoryMethodInfo {
  method_name: string;
  return_type: string; // The T in Future<T> or innermost T in Future<DataState<T>>
  full_return_type_string: string; // e.g. DataState<List<CountryModel>> or List<CountryModel> if Future<List<CountryModel>>
  params: RepositoryParamInfo[];
  data_source_method_name: string;
}

interface RepositoryInfo {
  repository_name: string | null;
  interface_name: string | null;
  data_source_interface_name: string | null;
  file_name: string;
  methods: RepositoryMethodInfo[];
  repository_import_path: string;
  data_source_import_path: string | null;
  all_source_file_imports: string[];
}

class RepositoryTestGenerator {
  private extract_inner_types(paramsString: string | null): InnerType[] {
    // This method was part of the DataSource generator.
    // If RepositoryParamInfo is different, this might need adjustment or a new method.
    // For now, assuming it's adaptable or RepositoryParamInfo is similar enough.
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

  private parseMethodSignature(
    signatureString: string
  ): {
    returnType: string;
    fullReturnType: string;
    methodName: string;
    params: RepositoryParamInfo[];
  } | null {
    const methodRegex =
      /Future<((?:[^>]|<[^>]*>)+)>\s*([a-zA-Z_]\w*)\s*\(([^)]*)\)\s*(async)?/;
    const match = signatureString.trim().match(methodRegex);

    if (!match) return null;

    const fullReturnTypeExtracted = match[1].trim();
    const methodName = match[2].trim();
    const paramsString = match[3].trim();
    const params: RepositoryParamInfo[] = [];

    if (paramsString) {
      const paramSegments = paramsString
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s);
      let inNamedParamsScope = false;
      for (let segment of paramSegments) {
        segment = segment.trim();
        if (!segment) continue;

        if (segment.startsWith("{")) {
          inNamedParamsScope = true;
          segment = segment.substring(1).trim();
        }
        if (segment.endsWith("}")) {
          // This logic is simple, might not handle all edge cases for named params
          segment = segment.substring(0, segment.length - 1).trim();
        }
        if (
          !segment &&
          inNamedParamsScope &&
          paramSegments.length === 1 &&
          segment.includes("{") &&
          segment.includes("}")
        ) {
          // Handles case like `method({})` which means empty named params
        } else if (!segment) {
          continue;
        }

        const isRequiredKeyword = segment.startsWith("required ");
        if (isRequiredKeyword) {
          segment = segment.substring("required ".length).trim();
        }

        // Attempt to find the last space to separate type and name
        const lastSpaceIdx = segment.lastIndexOf(" ");
        let name: string;
        let type: string;
        let isOptional: boolean;

        if (lastSpaceIdx > -1) {
          type = segment.substring(0, lastSpaceIdx).trim();
          name = segment.substring(lastSpaceIdx + 1).trim();
        } else {
          // No space, assume it's a name and type is dynamic, or it's a field-formal this.name
          if (segment.startsWith("this.")) {
            name = segment.substring(5);
            type = "dynamic"; // Type would be inferred from class member
          } else {
            name = segment;
            type = "dynamic"; // Or consider it an error/skip
          }
        }

        isOptional = type.endsWith("?") || name.endsWith("?");
        type = type.replace(/\?$/, ""); // Remove trailing ? from type
        name = name.replace(/\?$/, ""); // Remove trailing ? from name

        params.push({
          name: name,
          type: type,
          isOptional: isOptional || (inNamedParamsScope && !isRequiredKeyword),
          isNamed: inNamedParamsScope,
        });
      }
    }

    let extractedReturnType = fullReturnTypeExtracted;
    const dataStateMatch = fullReturnTypeExtracted.match(
      /^DataState<((?:[^>]|<[^>]*>)+)>$/
    );
    if (dataStateMatch && dataStateMatch[1]) {
      extractedReturnType = dataStateMatch[1].trim();
    }

    return {
      returnType: extractedReturnType.replace(/\?$/, ""),
      fullReturnType: fullReturnTypeExtracted.replace(/\?$/, ""),
      methodName,
      params,
    };
  }

  private extractDataSourceInfoInMethodBody(
    methodBody: string,
    repoDataSourceInterfaceName: string | null,
    allRepoImports: string[]
  ): {
    dsInterfaceName: string | null;
    dsMethodName: string | null;
    dsImportPath: string | null;
  } {
    const getItCallRegex =
      /(?:await\s+)?getIt<([a-zA-Z_][\w<>,?\s]*)>\(\)\.([a-zA-Z_]\w*)\s*\(/m;
    const match = methodBody.match(getItCallRegex);

    if (match) {
      const dsInterfaceName = match[1].trim();
      const dsMethodName = match[2].trim();
      let dsImportPath: string | null = null;

      if (dsInterfaceName) {
        const potentialFileNamePart = dsInterfaceName.startsWith("I")
          ? dsInterfaceName.substring(1)
          : dsInterfaceName;
        const importRegex = new RegExp(
          `import\\s+['"](package:[^'"]+\\/(${potentialFileNamePart
            .toLowerCase()
            .replace(
              /(datasource|source)$/i,
              ""
            )}(_data_source)?\\.dart|${dsInterfaceName}\\.dart))['"];`,
          "i"
        );

        for (const imp of allRepoImports) {
          const importMatch = imp.match(importRegex);
          if (importMatch && importMatch[1]) {
            dsImportPath = importMatch[1];
            break;
          }
        }
        if (!dsImportPath) {
          const genericImportMatch = allRepoImports.find(
            (imp) =>
              imp.includes(`/${dsInterfaceName}.dart`) ||
              imp.includes(`/${dsInterfaceName.toLowerCase()}.dart`)
          );
          if (genericImportMatch) {
            const matchedPath = genericImportMatch.match(
              /import\s+['"]([^'"]+)['"];/
            );
            if (matchedPath && matchedPath[1]) dsImportPath = matchedPath[1];
          }
        }
      }
      return { dsInterfaceName, dsMethodName, dsImportPath };
    }
    if (repoDataSourceInterfaceName) {
      const memberCallRegex = new RegExp(
        `(?:await\\s+)?_\\w+(?:DataSource|Source|Service)\\.([a-zA-Z_]\\w*)\\s*\\(`,
        "m"
      );
      const memberMatch = methodBody.match(memberCallRegex);
      if (memberMatch && memberMatch[1]) {
        // Try to find import path for repoDataSourceInterfaceName if not already found
        let knownDsImportPath: string | null = null;
        if (repoDataSourceInterfaceName) {
          const potentialFileNamePart = repoDataSourceInterfaceName.startsWith(
            "I"
          )
            ? repoDataSourceInterfaceName.substring(1)
            : repoDataSourceInterfaceName;
          const importRegex = new RegExp(
            `import\\s+['"](package:[^'"]+\\/(${potentialFileNamePart
              .toLowerCase()
              .replace(
                /(datasource|source)$/i,
                ""
              )}(_data_source)?\\.dart|${repoDataSourceInterfaceName}\\.dart))['"];`,
            "i"
          );
          for (const imp of allRepoImports) {
            const importMatch = imp.match(importRegex);
            if (importMatch && importMatch[1]) {
              knownDsImportPath = importMatch[1];
              break;
            }
          }
        }
        return {
          dsInterfaceName: repoDataSourceInterfaceName,
          dsMethodName: memberMatch[1],
          dsImportPath: knownDsImportPath,
        };
      }
    }
    return { dsInterfaceName: null, dsMethodName: null, dsImportPath: null };
  }

  private extractRepositoryClassNameAndInterface(
    line: string
  ): [string | null, string | null] {
    const classRegex = /class\s+([a-zA-Z0-9_]+)\s+implements\s+([a-zA-Z0-9_]+)/;
    const match = line.match(classRegex);
    if (match) {
      return [match[1], match[2]];
    }
    return [null, null];
  }

  private processRepositoryFile(
    filePath: string,
    projectPackageName: string,
    libDirRelativePathForFile: string
  ): RepositoryInfo | null {
    const fileContent = fs.readFileSync(filePath, "utf-8");
    const lines = fileContent.split("\n");

    const repoInfo: RepositoryInfo = {
      repository_name: null,
      interface_name: null,
      data_source_interface_name: null,
      file_name: path.basename(filePath).replace(".dart", ""),
      methods: [],
      repository_import_path: `package:${projectPackageName}/${libDirRelativePathForFile.replace(
        /\\/g,
        "/"
      )}`,
      data_source_import_path: null,
      all_source_file_imports: [],
    };

    repoInfo.all_source_file_imports = lines
      .filter((line) => line.trim().startsWith("import "))
      .map((line) => line.trim());

    let isInsideRelevantClassDefinition = false;
    let classBraceDepth = 0;

    let currentMethodLines: string[] = [];
    let methodBraceDepth = 0;
    let collectingMethod = false;
    let firstBraceOfMethodFound = false;

    for (const line of lines) {
      const trimmedLine = line.trim();

      if (!repoInfo.repository_name) {
        const [repoName, interfaceName] =
          this.extractRepositoryClassNameAndInterface(trimmedLine);
        if (repoName) repoInfo.repository_name = repoName;
        if (interfaceName) repoInfo.interface_name = interfaceName;
        if (repoName && trimmedLine.includes(`class ${repoName}`)) {
          if (
            trimmedLine.includes("@Injectable") ||
            lines.some(
              (l) =>
                l.includes("@Injectable") && l.includes(`as: ${interfaceName}`)
            )
          ) {
            isInsideRelevantClassDefinition = true;
          } else if (
            !trimmedLine.includes("@Injectable") &&
            !lines.some((l) => l.includes("@Injectable"))
          ) {
            // If no @Injectable at all, might be a simple class, proceed with caution
            // isInsideRelevantClassDefinition = true;
          }
          if (isInsideRelevantClassDefinition) {
            for (const char of line) {
              if (char === "{") classBraceDepth++;
              else if (char === "}") classBraceDepth--;
            }
          }
        }
      } else if (
        isInsideRelevantClassDefinition &&
        !trimmedLine.startsWith("//")
      ) {
        for (const char of line) {
          if (char === "{") classBraceDepth++;
          else if (char === "}") classBraceDepth--;
        }
      }

      if (isInsideRelevantClassDefinition) {
        if (trimmedLine.startsWith("@override")) {
          if (collectingMethod) {
            currentMethodLines = [];
            methodBraceDepth = 0;
            firstBraceOfMethodFound = false;
          }
          collectingMethod = true;
          currentMethodLines.push(line);
        } else if (collectingMethod) {
          currentMethodLines.push(line);
          for (const char of line) {
            if (char === "{") {
              methodBraceDepth++;
              if (!firstBraceOfMethodFound) firstBraceOfMethodFound = true;
            } else if (char === "}") methodBraceDepth--;
          }

          if (
            firstBraceOfMethodFound &&
            methodBraceDepth === 0 &&
            currentMethodLines.length > 0 &&
            trimmedLine.endsWith("}")
          ) {
            const methodBlock = currentMethodLines.join("\n");
            const signatureLineRaw = currentMethodLines.find(
              (l) =>
                l.includes("Future<") &&
                l.includes("(") &&
                !l.trim().startsWith("@override")
            );

            if (signatureLineRaw) {
              const signatureToParse = signatureLineRaw.trim();
              const parsedSignature =
                this.parseMethodSignature(signatureToParse);

              if (parsedSignature) {
                const methodBodyStartIndex = methodBlock.indexOf("{");
                const methodBodyEndIndex = methodBlock.lastIndexOf("}");
                let methodBodyOnly = "";
                if (
                  methodBodyStartIndex !== -1 &&
                  methodBodyEndIndex > methodBodyStartIndex
                ) {
                  methodBodyOnly = methodBlock.substring(
                    methodBodyStartIndex + 1,
                    methodBodyEndIndex
                  );
                }

                const dsInfo = this.extractDataSourceInfoInMethodBody(
                  methodBodyOnly,
                  repoInfo.data_source_interface_name,
                  repoInfo.all_source_file_imports
                );

                if (
                  dsInfo.dsInterfaceName &&
                  !repoInfo.data_source_interface_name
                ) {
                  repoInfo.data_source_interface_name = dsInfo.dsInterfaceName;
                }
                if (
                  dsInfo.dsImportPath &&
                  (!repoInfo.data_source_import_path ||
                    repoInfo.data_source_interface_name ===
                      dsInfo.dsInterfaceName)
                ) {
                  repoInfo.data_source_import_path = dsInfo.dsImportPath;
                }

                if (dsInfo.dsMethodName) {
                  // Only add method if a data source call is identified
                  repoInfo.methods.push({
                    method_name: parsedSignature.methodName,
                    return_type: parsedSignature.returnType,
                    full_return_type_string: parsedSignature.fullReturnType,
                    params: parsedSignature.params,
                    data_source_method_name: dsInfo.dsMethodName,
                  });
                }
              }
            }
            currentMethodLines = [];
            collectingMethod = false;
            firstBraceOfMethodFound = false;
          }
        }
      }
      if (
        isInsideRelevantClassDefinition &&
        classBraceDepth === 0 &&
        currentMethodLines.length === 0 &&
        trimmedLine.endsWith("}")
      ) {
        // This implies the class itself has ended
        isInsideRelevantClassDefinition = false;
      }
    }

    if (repoInfo.repository_name && !repoInfo.data_source_interface_name) {
      const constructorRegex = new RegExp(
        `(?:final\\s+)?([A-Z]\\w*DataSource)\\s+(_\\w+);|${repoInfo.repository_name}\\s*\\(\\s*\\{\\s*(?:this\\._\\w+,\\s*)*?(?:required\\s+)?([A-Z]\\w*DataSource)\\s`
      );
      const fileContentMatch = fileContent.match(constructorRegex);
      if (fileContentMatch) {
        const dsNameFromConstructor =
          fileContentMatch[1] || fileContentMatch[2] || fileContentMatch[3];
        if (dsNameFromConstructor) {
          repoInfo.data_source_interface_name = dsNameFromConstructor.trim();
          const potentialFileNamePart =
            repoInfo.data_source_interface_name.startsWith("I")
              ? repoInfo.data_source_interface_name.substring(1)
              : repoInfo.data_source_interface_name;
          const importRegex = new RegExp(
            `import\\s+['"](package:[^'"]+\\/(${potentialFileNamePart
              .toLowerCase()
              .replace(/(datasource|source)$/i, "")}(_data_source)?\\.dart|${
              repoInfo.data_source_interface_name
            }\\.dart))['"];`,
            "i"
          );
          for (const imp of repoInfo.all_source_file_imports) {
            const importMatch = imp.match(importRegex);
            if (importMatch && importMatch[1]) {
              repoInfo.data_source_import_path = importMatch[1];
              break;
            }
          }
        }
      }
    }

    return repoInfo.repository_name &&
      repoInfo.data_source_interface_name &&
      repoInfo.methods.length > 0
      ? repoInfo
      : null;
  }

  private findRepositoryFiles(directory: string): string[] {
    const repositoryFiles: string[] = [];
    try {
      const items = fs.readdirSync(directory, { withFileTypes: true });
      for (const item of items) {
        const fullPath = path.join(directory, item.name);
        if (item.isDirectory()) {
          repositoryFiles.push(...this.findRepositoryFiles(fullPath));
        } else if (
          item.isFile() &&
          item.name.endsWith(".dart") &&
          item.name.toLowerCase().includes("repository")
        ) {
          repositoryFiles.push(fullPath);
        }
      }
    } catch (e) {
      /* ignore errors */
    }
    return repositoryFiles;
  }

  private generateFakeData(paramType: string, paramName: string): string {
    const type = paramType.toLowerCase().replace(/\?$/, "").trim();
    if (type === "string") return `'test_${paramName}'`;
    if (type === "int" || type === "integer") return "1";
    if (type === "double") return "1.0";
    if (type === "num") return "1";
    if (type === "bool" || type === "boolean") return "true";
    if (type.startsWith("list<")) return "[]";
    if (type.startsWith("map<")) return `{"test_key": "test_value"}`; // More valid map

    // Use getAllModels and getTestValue for complex types if available and integrated
    // For now, simple instantiation:
    if (/[A-Z]/.test(paramType.charAt(0))) {
      // Heuristic: type starts with an uppercase letter
      // Check if it's a known model type that might need specific construction
      const models = getAllModels(); // Assumes getAllModels() is available
      const modelInfo = models.find(
        (m) => m.modelName === paramType.replace(/\?$/, "")
      );
      if (modelInfo) {
        return getTestValue(paramType.replace(/\?$/, ""), models); // Assumes getTestValue is available
      }
      return `${paramType.replace(/\?$/, "")}()`; // Default constructor
    }
    return "null";
  }

  private generateRepositoryTestMethodBlock(
    method: RepositoryMethodInfo,
    repoClassName: string,
    dataSourceInterfaceName: string
  ): string {
    const paramsForRepoCall = method.params
      .map((p) => {
        const fakeData = this.generateFakeData(p.type, p.name);
        return p.isNamed ? `${p.name}: ${fakeData}` : fakeData;
      })
      .join(", ");

    const mockDsVariableName = `mock${dataSourceInterfaceName}`;

    const dsCallArgs = method.params.length > 0 ? "any" : "";

    // Create a sensible default for tResponse
    let tResponseValue: string;
    const cleanReturnType = method.return_type; // This is T from Future<DataState<T>> or Future<T>
    const returnTypeLower = cleanReturnType.toLowerCase();

    if (returnTypeLower === "string") tResponseValue = "''";
    else if (
      returnTypeLower === "int" ||
      returnTypeLower === "integer" ||
      returnTypeLower === "num"
    )
      tResponseValue = "0";
    else if (returnTypeLower === "double") tResponseValue = "0.0";
    else if (returnTypeLower === "bool" || returnTypeLower === "boolean")
      tResponseValue = "true";
    else if (returnTypeLower.startsWith("list<")) tResponseValue = "[]";
    else if (returnTypeLower.startsWith("map<")) tResponseValue = "{}";
    else if (/[A-Z]/.test(cleanReturnType.charAt(0))) {
      // Heuristic for class type
      // If full_return_type_string is DataState<T>, and T is a class, instantiate T.
      // Otherwise, instantiate full_return_type_string directly if it's not DataState
      if (
        method.full_return_type_string.startsWith("DataState<") &&
        method.full_return_type_string.endsWith(">")
      ) {
        tResponseValue = `${cleanReturnType}()`; // Instance of T
      } else {
        tResponseValue = `${method.full_return_type_string}()`; // Instance of FullType
      }
    } else tResponseValue = "null";

    return `//***${method.method_name}-START***//
  group('${method.method_name}', () {
    test('should call data source and return its result on success', () async {
      // Arrange
      final tResponseData = ${tResponseValue};
      // If the full return type is DataState<T>, wrap tResponseData in DataSuccess or similar
      // Assuming DataSuccess constructor if method.full_return_type_string is like DataState<...>
      final tResponse = ${
        method.full_return_type_string.startsWith("DataState<")
          ? `DataSuccess(tResponseData)`
          : `tResponseData`
      };
      
      when(${mockDsVariableName}.${
      method.data_source_method_name
    }(${dsCallArgs}))
          .thenAnswer((_) async => tResponse);

      // Act
      final result = await repository.${
        method.method_name
      }(${paramsForRepoCall});

      // Assert
      verify(${mockDsVariableName}.${
      method.data_source_method_name
    }(${dsCallArgs})).called(1);
      expect(result, equals(tResponse));
      expect(result, isA<${method.full_return_type_string}>());
    });

    test('should throw when data source throws', () async {
      // Arrange
      final exception = Exception('Test Exception');
      when(${mockDsVariableName}.${
      method.data_source_method_name
    }(${dsCallArgs}))
          .thenThrow(exception);

      // Act
      final call = repository.${method.method_name};

      // Assert
      expect(() => call(${paramsForRepoCall}), throwsA(isA<Exception>()));
      verify(${mockDsVariableName}.${
      method.data_source_method_name
    }(${dsCallArgs})).called(1);
    });
  });
//***${method.method_name}-END***//`;
  }

  private findAllMockFileImports(
    newTestFileDir: string,
    projectTestRoot: string,
    currentTestSpecificMockFileName: string
  ): string {
    const mockImportStatements: string[] = [];
    try {
      const findMocksRecursive = (currentDir: string) => {
        if (!fs.existsSync(currentDir)) return;
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
            relativePath = relativePath.replace(/\\/g, "/");
            const importStatement = `import '${relativePath}';`;
            if (!mockImportStatements.includes(importStatement)) {
              // Avoid duplicates
              mockImportStatements.push(importStatement);
            }
          }
        }
      };
      findMocksRecursive(projectTestRoot);
    } catch (e) {
      /* ignore errors */
    }
    return mockImportStatements.join("\n");
  }

  private generateInitialRepositoryTestFileContent(
    repoInfo: RepositoryInfo,
    projectPackageName: string,
    additionalMockImports: string
  ): string {
    const {
      repository_name,
      methods,
      data_source_interface_name,
      repository_import_path,
      data_source_import_path,
      all_source_file_imports,
    } = repoInfo;
    if (!repository_name || !data_source_interface_name) {
      return `// Error: Could not determine repository name or data source interface name for ${repoInfo.file_name}`;
    }

    const mockDsVariableName = `mock${data_source_interface_name}`;

    const specificPackageImportsFromSource = all_source_file_imports
      .filter(
        (imp) =>
          imp.includes("package:") &&
          !imp.includes("package:flutter_test/") &&
          !imp.includes("package:mockito/") &&
          !imp.includes("package:dio/") &&
          !imp.includes("package:get_it/") &&
          !imp.includes("package:injectable/") &&
          imp !== repository_import_path &&
          imp !== data_source_import_path
      )
      .join("\n");

    let testCode = `import 'package:flutter_test/flutter_test.dart';
import 'package:mockito/mockito.dart';
import 'package:mockito/annotations.dart';
import 'package:get_it/get_it.dart';
${
  additionalMockImports ? additionalMockImports + "\n" : ""
}import '${repository_import_path}';
${
  data_source_import_path
    ? `import '${data_source_import_path}';`
    : `// TODO: Add import for ${data_source_interface_name}`
}
${
  specificPackageImportsFromSource
    ? specificPackageImportsFromSource + "\n"
    : ""
}//***IMPORTS***//

@GenerateMocks([${data_source_interface_name}])
import '${repoInfo.file_name}_test.mocks.dart';

final getIt = GetIt.instance;

void main() {
  late ${repository_name} repository;
  late Mock${data_source_interface_name} ${mockDsVariableName};

  setUp(() {
    ${mockDsVariableName} = Mock${data_source_interface_name}();
    getIt.registerSingleton<${data_source_interface_name}>(${mockDsVariableName});
    repository = ${repository_name}(); 
  });

  tearDown(() {
    getIt.reset();
  });\n`;

    for (const method of methods) {
      testCode +=
        this.generateRepositoryTestMethodBlock(
          method,
          repository_name,
          data_source_interface_name
        ) + "\n\n";
    }

    testCode += `  //***LAST-LINE***//\n}\n`;
    return testCode;
  }

  private async createRepositoryTestFile(
    repoInfo: RepositoryInfo,
    originalFilePath: string,
    projectRoot: string,
    projectPackageName: string
  ): Promise<string | null> {
    const libDir = path.join(projectRoot, "lib");
    const testDir = path.join(projectRoot, "test");
    const relativePathOriginalFileFromLib = path.relative(
      libDir,
      originalFilePath
    );

    const testFileDirPath = path.join(
      testDir,
      path.dirname(relativePathOriginalFileFromLib)
    );
    const testFileName = `${repoInfo.file_name}_test.dart`;
    const testFilePath = path.join(testFileDirPath, testFileName);

    try {
      if (!fs.existsSync(testFileDirPath)) {
        fs.mkdirSync(testFileDirPath, { recursive: true });
      }

      const projectTestRoot = path.join(projectRoot, "test"); // Corrected testDirName to 'test'
      const currentTestSpecificMockFileName = `${repoInfo.file_name}_test.mocks.dart`;

      if (fs.existsSync(testFilePath)) {
        let existingContent = fs.readFileSync(testFilePath, "utf-8");
        let contentModified = false;
        const importsMarker = "//***IMPORTS***//";
        const lastLineMarker = "//***LAST-LINE***//";

        const otherMockImports = this.findAllMockFileImports(
          testFileDirPath,
          projectTestRoot,
          currentTestSpecificMockFileName
        );
        let newRequiredImports = "";

        if (
          repoInfo.data_source_import_path &&
          !existingContent.includes(
            path.basename(repoInfo.data_source_import_path)
          )
        ) {
          // Check basename to avoid issues with relative vs package
          newRequiredImports += `import '${repoInfo.data_source_import_path}';\n`;
        }

        const existingOtherMockImports = this.findAllMockFileImports(
          testFileDirPath,
          projectTestRoot,
          currentTestSpecificMockFileName
        )
          .split("\n")
          .filter((imp) => imp.trim() !== "" && !existingContent.includes(imp))
          .join("\n");

        if (existingOtherMockImports) {
          newRequiredImports += existingOtherMockImports + "\n";
        }

        repoInfo.all_source_file_imports
          .filter(
            (imp) =>
              imp.includes("package:") &&
              !imp.includes("package:flutter_test/") &&
              !imp.includes("package:mockito/") &&
              !imp.includes("package:dio/") &&
              !imp.includes("package:get_it/") &&
              !imp.includes("package:injectable/") &&
              imp !== repoInfo.repository_import_path &&
              imp !== repoInfo.data_source_import_path &&
              !existingContent.includes(imp.split(" ")[1])
          ) // Check actual path part of import
          .forEach((imp) => (newRequiredImports += imp + "\n"));

        if (newRequiredImports.trim()) {
          if (existingContent.includes(importsMarker)) {
            existingContent = existingContent.replace(
              importsMarker,
              `${newRequiredImports.trim()}\n${importsMarker}`
            );
          } else {
            const generateMocksLineEnd =
              existingContent.indexOf(".mocks.dart';") + ".mocks.dart';".length;
            if (generateMocksLineEnd > ".mocks.dart';".length - 1) {
              existingContent =
                existingContent.slice(0, generateMocksLineEnd) +
                `\n${newRequiredImports.trim()}\n${importsMarker}` +
                existingContent.slice(generateMocksLineEnd);
            } else {
              const mainFunctionStart =
                existingContent.indexOf("void main() {");
              if (mainFunctionStart !== -1) {
                existingContent =
                  existingContent.slice(0, mainFunctionStart) +
                  `${newRequiredImports.trim()}\n${importsMarker}\n` +
                  existingContent.slice(mainFunctionStart);
              } else {
                existingContent =
                  `${newRequiredImports.trim()}\n${importsMarker}\n` +
                  existingContent; // Fallback
              }
            }
          }
          contentModified = true;
        }

        let newMethodBlocksCombined = "";
        for (const method of repoInfo.methods) {
          const startMarker = `//***${method.method_name}-START***//`;
          if (!existingContent.includes(startMarker)) {
            newMethodBlocksCombined +=
              this.generateRepositoryTestMethodBlock(
                method,
                repoInfo.repository_name!,
                repoInfo.data_source_interface_name!
              ) + "\n\n";
            contentModified = true;
          }
        }

        if (newMethodBlocksCombined) {
          if (existingContent.includes(lastLineMarker)) {
            existingContent = existingContent.replace(
              lastLineMarker,
              newMethodBlocksCombined.trimEnd() + "\n    " + lastLineMarker
            );
          } else {
            const mainGroupEndIndex = existingContent.lastIndexOf("});");
            if (
              mainGroupEndIndex !== -1 &&
              existingContent.substring(mainGroupEndIndex).trim() === "});"
            ) {
              // Ensure it's the main group
              const beforeEnd = existingContent.substring(0, mainGroupEndIndex);
              const endPart = existingContent.substring(mainGroupEndIndex);
              existingContent =
                beforeEnd +
                "\n" +
                newMethodBlocksCombined.trimEnd() +
                "\n    " +
                lastLineMarker +
                "\n" +
                endPart;
              contentModified = true;
            } else {
              // Fallback if specific end not found
              const lastBrace = existingContent.lastIndexOf("}");
              if (lastBrace !== -1) {
                existingContent =
                  existingContent.substring(0, lastBrace) +
                  "\n" +
                  newMethodBlocksCombined.trimEnd() +
                  "\n    " +
                  lastLineMarker +
                  "\n}";
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
          testFileDirPath,
          projectTestRoot,
          currentTestSpecificMockFileName
        );
        const testCode = this.generateInitialRepositoryTestFileContent(
          repoInfo,
          projectPackageName,
          additionalMockImports
        );
        if (testCode && !testCode.startsWith("// Error:")) {
          fs.writeFileSync(testFilePath, testCode, "utf-8");
        } else if (testCode.startsWith("// Error:")) {
          vscode.window.showErrorMessage(testCode);
        }
      }
      return testFilePath;
    } catch (e: any) {
      vscode.window.showErrorMessage(
        `Error creating/updating test file ${testFilePath}: ${e.message || e}`
      );
      return null;
    }
  }

  public async generateTestsForPath(uri: vscode.Uri): Promise<void> {
    const resourcePath = uri.fsPath;
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
    if (!workspaceFolder) {
      vscode.window.showErrorMessage(
        "No workspace folder found. Please open a Flutter project."
      );
      return;
    }
    const projectRoot = workspaceFolder.uri.fsPath;
    const libDir = path.join(projectRoot, "lib");
    // const testDirName = 'test'; // Used in findAllMockFileImports context via projectTestRoot

    let projectPackageName = path.basename(projectRoot);
    try {
      const pubspecPath = path.join(projectRoot, "pubspec.yaml");
      if (fs.existsSync(pubspecPath)) {
        const pubspecContent = fs.readFileSync(pubspecPath, "utf-8");
        const match = pubspecContent.match(/^name:\s*(\S+)/m);
        if (match && match[1]) projectPackageName = match[1];
      }
    } catch (e) {
      /* Ignore error reading pubspec */
    }

    let filesToProcess: string[] = [];
    try {
      if (fs.statSync(resourcePath).isDirectory()) {
        filesToProcess = this.findRepositoryFiles(resourcePath);
      } else if (
        resourcePath.endsWith(".dart") &&
        resourcePath.toLowerCase().includes("repository")
      ) {
        filesToProcess = [resourcePath];
      } else {
        vscode.window.showInformationMessage(
          "Selected resource is not a directory or a Dart repository file."
        );
        return;
      }
    } catch (e: any) {
      vscode.window.showErrorMessage(
        `Error accessing resource: ${e.message || e}`
      );
      return;
    }

    if (filesToProcess.length === 0) {
      vscode.window.showInformationMessage(
        "No repository files found in the selection."
      );
      return;
    }

    let count = 0;
    vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Generating Repository Tests",
        cancellable: false,
      },
      async (progress) => {
        for (let i = 0; i < filesToProcess.length; i++) {
          const filePath = filesToProcess[i];
          progress.report({
            message: `Processing ${path.basename(filePath)} (${i + 1}/${
              filesToProcess.length
            })`,
          });

          const relativePathFromLibForFile = path.relative(libDir, filePath); // Use this for repo import path
          const repoInfo = this.processRepositoryFile(
            filePath,
            projectPackageName,
            relativePathFromLibForFile
          );
          if (repoInfo) {
            const testFilePathGenerated = await this.createRepositoryTestFile(
              repoInfo,
              filePath,
              projectRoot,
              projectPackageName
            );
            if (testFilePathGenerated) count++;
          } else {
            // vscode.window.showWarningMessage(`Could not fully process repository file (or no methods found): ${path.basename(filePath)}`);
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        vscode.window.showInformationMessage(
          `Generated/updated ${count} repository test file(s).`
        );
      }
    );
  }
}

export async function registerRepositoryTestGeneratorModule(
  context: vscode.ExtensionContext
): Promise<void> {
  const disposable = vscode.commands.registerCommand(
    "extension.generateRepositoryTest",
    async (uri?: vscode.Uri) => {
      let resourceUri = uri;
      if (!resourceUri) {
        const activeEditor = vscode.window.activeTextEditor;
        if (activeEditor && activeEditor.document.uri.scheme === "file") {
          resourceUri = activeEditor.document.uri;
        } else {
          vscode.window.showErrorMessage(
            "Please select a file or folder in the explorer or open a repository file."
          );
          return;
        }
      }
      const generator = new RepositoryTestGenerator();
      await generator.generateTestsForPath(resourceUri);
    }
  );
  context.subscriptions.push(disposable);
}
