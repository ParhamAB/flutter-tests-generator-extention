import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { getAllModels } from "../utils/model_utils";

export interface ModelInfo {
  modelName: string;
  fields: Record<string, string>;
  importPath: string;
  hasToJson?: boolean;
  hasFromJson?: boolean;
}

function extractModelInfo(fileContent: string): ModelInfo[] {
  const modelClasses: ModelInfo[] = [];
  let importPath = fileContent.split("class")[0].trim();

  const classRegex = /class\s+(\w+)\s*{/g;
  let match: RegExpExecArray | null;

  while ((match = classRegex.exec(fileContent)) !== null) {
    const modelName = match[1];
    const classStart = match.index;
    const braceStart = fileContent.indexOf("{", classStart);

    // Extract the full class body using brace counting
    let i = braceStart + 1;
    let braceCount = 1;
    while (i < fileContent.length && braceCount > 0) {
      if (fileContent[i] === "{") braceCount++;
      else if (fileContent[i] === "}") braceCount--;
      i++;
    }

    const classBody = fileContent.substring(braceStart + 1, i - 1);

    // Parse fields
    const fields: Record<string, string> = {};
    const fieldMatches = [
      ...classBody.matchAll(/^\s*([\w<>?\[\]]+)\s+(\w+);/gm),
    ];
    for (const match of fieldMatches) {
      const fieldType = match[1];
      const fieldName = match[2];
      fields[fieldName] = fieldType;
    }

    const hasToJson = /toJson\s*\(/.test(classBody);
    const hasFromJson = /fromJson\s*\(/.test(classBody);

    modelClasses.push({
      modelName,
      fields,
      importPath,
      hasToJson,
      hasFromJson,
    });
  }

  return modelClasses;
}


function getTestValue(
  fieldType: string,
  modelsPriority: ModelInfo[] = []
): string {
  if(fieldType.includes("PlatformFile")) return "PlatformFile(name: '',size: 1)";
  if (fieldType.includes("List<"))
    return `<${fieldType.split("<")[1].split(">")[0]}>[]`;
  if (fieldType.includes("String")) return '""';
  if (fieldType.includes("int")) return "0";
  if (fieldType.includes("bool")) return "true";
  if (fieldType.includes("double")) return "0.0";
  if (fieldType.includes("dynamic")) return '{"" : ""}';
  let sampleModel: ModelInfo | undefined;
  if (modelsPriority.length > 0) {
    sampleModel = modelsPriority.find(
      (el) => el.modelName === fieldType.replaceAll("?", "").replaceAll("!", "")
    );
  } else {
    let models = getAllModels();
    sampleModel = models.find(
      (el) => el.modelName === fieldType.replaceAll("?", "").replaceAll("!", "")
    );
  }
  let fieldLines = "";
  if (sampleModel !== undefined && sampleModel !== null) {
    fieldLines = Object.entries(sampleModel!.fields)
      .map(
        ([fieldName, fieldType]) =>
          `${fieldName}: ${getTestValue(fieldType, modelsPriority)}`
      )
      .join(", ");
  }

  return fieldType
    ? `${
        fieldType.replaceAll("?", "").replaceAll("!", "") == "DateTime"
          ? fieldType.replaceAll("?", "").replaceAll("!", "") + ".now"
          : fieldType.replaceAll("?", "").replaceAll("!", "")
      }(${
        sampleModel !== null && sampleModel !== undefined && fieldLines !== ""
          ? fieldLines
          : ""
      })`
    : "";
}

function generateModelTest(
  models: ModelInfo[],
  importPath: string,
  existingContent: string = ""
): string {
  const jsonExampleStr = '{"test": "test"}';
  let imports = ``;
  const isNewFile = existingContent.trim() === "";
  let allModels = getAllModels();

  let newModelTests = "";
  for (const model of models) {
    const modelStartPattern = `//***${model.modelName}-START***//`;
    if (existingContent.includes(modelStartPattern)) {
      continue;
    }
    let tempImports = model.importPath.split("import");
    tempImports.forEach((el) => {
      if (
        !imports.includes(el.replaceAll("'", "").replaceAll(";", "").trim())
      ) {
        if (el.includes("package:")) {
          imports += `import '${el
            .replaceAll("'", "")
            .replaceAll(";", "")
            .trim()}';\n`;
        } else {
          let modelImportTemp = allModels.find((el2) =>
            el2.importPath.includes(
              el.replaceAll("'", "").replaceAll(";", "").trim()
            )
          );
          if (modelImportTemp !== null && modelImportTemp !== undefined) {
            imports += `import '${modelImportTemp.importPath}';\n`;
          }
        }
      }
    });

    // const temp = Object.entries(model.fields);
    // let models = getAllModels();

    // temp.forEach(([fieldName, fieldType]) => {
    //   let sampleModel = models.find(
    //     (el) =>
    //       el.modelName === fieldType.replaceAll("?", "").replaceAll("!", "")
    //   );
    //   if (sampleModel !== undefined && sampleModel !== null) {
    //     if (!imports.includes(`import "${sampleModel.importPath}";`) && !imports.includes(importPath)) {
    //       imports += `import "${sampleModel.importPath}";\n\n`;
    //     }
    //   }
    // });

    const fieldLines = Object.entries(model.fields)
      .map(
        ([fieldName, fieldType]) =>
          `${fieldName}: ${getTestValue(fieldType, models)}`
      )
      .join(", ");

    newModelTests += `
  //***${model.modelName}-START***//
  group('${model.modelName} Model Test', () {
    test('toJson and fromJson', () {
      ${
        model.hasToJson !== undefined && model.hasToJson === true
          ? `final ${model.modelName.toLowerCase()} = `
          : ""
      }${model.modelName}(
        ${fieldLines}
      );

      ${
        model.hasToJson !== undefined && model.hasToJson === true
          ? `${model.modelName.toLowerCase()}.toJson();`
          : ""
      }
      ${
        model.hasFromJson !== undefined && model.hasFromJson === true
          ? `${model.modelName}.fromJson(${jsonExampleStr});`
          : ""
      }
    });
  });
  //***${model.modelName}-END***//
`;
  }

  if (newModelTests === "" && !isNewFile) {
    return existingContent;
  }

  if (isNewFile || !existingContent.includes("//***LAST-LINE***//")) {
    let testFileContent = `
//DO NOT CHANGE OR CLEAN THE COMMENTS UNLESS IF U WANT TO REMAKE THAT TEST
import 'package:flutter_test/flutter_test.dart';
import '${importPath}';${imports !== "" ? "\n" : ""}${imports}
//***IMPORTS***//

void main() {`;

    if (isNewFile) {
      for (const model of models) {
        const fieldLines = Object.entries(model.fields)
          .map(
            ([fieldName, fieldType]) =>
              `${fieldName}: ${getTestValue(fieldType, models)}`
          )
          .join(", ");

        testFileContent += `
  //***${model.modelName}-START***//
  group('${model.modelName} Model Test', () {
    test('toJson and fromJson', () {
      ${
        model.hasToJson !== undefined && model.hasToJson === true
          ? `final ${model.modelName.toLowerCase()} = `
          : ""
      }${model.modelName}(
        ${fieldLines}
      );

      ${
        model.hasToJson !== undefined && model.hasToJson === true
          ? `${model.modelName.toLowerCase()}.toJson();`
          : ""
      }
      ${
        model.hasFromJson !== undefined && model.hasFromJson === true
          ? `${model.modelName}.fromJson(${jsonExampleStr});`
          : ""
      }
    });
  });
  //***${model.modelName}-END***//
`;
      }
    } else {
      const mainStartIndex = existingContent.indexOf("void main() {");
      const mainEndIndex = existingContent.lastIndexOf("}");

      if (mainStartIndex !== -1 && mainEndIndex !== -1) {
        const mainContent = existingContent.slice(
          mainStartIndex + "void main() {".length,
          mainEndIndex
        );

        testFileContent += mainContent + newModelTests;
      } else {
        testFileContent += newModelTests;
      }
    }

    testFileContent += `
  //***LAST-LINE***//

}`;

    return testFileContent;
  } else {
    return existingContent
      .replace("//***LAST-LINE***//", newModelTests + "  //***LAST-LINE***//")
      .replace(
        "//***IMPORTS***//",
        `
      ${imports !== "" ? imports : null}
      //***IMPORTS***//
      `
      );
  }
}

async function checkFolderContainsModelFiles(
  folderPath: string
): Promise<boolean> {
  try {
    const files = await vscode.workspace.findFiles(
      new vscode.RelativePattern(folderPath, "*.dart"),
      null,
      1
    );
    return files.length > 0;
  } catch (error) {
    console.error("Error checking for model files:", error);
    return false;
  }
}

async function registerModelGeneratorCommand(allModels: ModelInfo[]) {
  return vscode.commands.registerCommand(
    "extension.generateModelTest",
    async (uri: vscode.Uri) => {
      if (!uri) {
        const activeUri = vscode.window.activeTextEditor?.document.uri;
        if (!activeUri) {
          vscode.window.showErrorMessage("No file or folder selected");
          return;
        }
        uri = activeUri;
      }

      if (!fs.existsSync(uri.fsPath)) {
        vscode.window.showErrorMessage(
          "Selected file or folder does not exist"
        );
        return;
      }

      const isDirectory = fs.lstatSync(uri.fsPath).isDirectory();
      const dartFiles: string[] = [];

      if (isDirectory) {
        const findModelFiles = (dir: string) => {
          try {
            const items = fs.readdirSync(dir);
            for (const item of items) {
              const fullPath = path.join(dir, item);
              try {
                const stat = fs.statSync(fullPath);
                if (stat.isDirectory()) {
                  findModelFiles(fullPath);
                } else if (
                  /model/i.test(item) &&
                  item.endsWith(".dart")
                ) {
                  dartFiles.push(fullPath);
                }
              } catch (err) {
                console.error(`Error processing ${fullPath}:`, err);
              }
            }
          } catch (err) {
            console.error(`Error reading directory ${dir}:`, err);
          }
        };
        findModelFiles(uri.fsPath);
      } else {
        if (
          /model/i.test(path.basename(uri.fsPath)) &&
          uri.fsPath.endsWith(".dart")
        ) {
          dartFiles.push(uri.fsPath);
        } else {
          vscode.window.showWarningMessage(
            "Selected file is not a Dart file containing 'model' in its name."
          );
          return;
        }
      }

      vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Generating model tests",
          cancellable: true,
        },
        async (progress, token) => {
          let totalFiles = dartFiles.length;
          let processed = 0;
          let successCount = 0;

          for (const filePath of dartFiles) {
            if (token.isCancellationRequested) {
              vscode.window.showWarningMessage("Test generation cancelled.");
              break;
            }
            try {
              progress.report({
                message: `Processing ${path.basename(filePath)} (${
                  processed + 1
                }/${totalFiles})`,
                increment: (1 / totalFiles) * 100,
              });

              const content = fs.readFileSync(filePath, "utf-8");
              const testFilePath = filePath
                .replace("lib", "test")
                .replace(".dart", "_test.dart");
              const testFileContent = fs.existsSync(testFilePath)
                ? fs.readFileSync(testFilePath, "utf-8")
                : "";

              const models = extractModelInfo(content);

              if (models.length > 0) {
                const workspaceFolders = vscode.workspace.workspaceFolders;
                let workspaceRoot = "";

                if (workspaceFolders && workspaceFolders.length > 0) {
                  workspaceRoot = workspaceFolders[0].uri.fsPath;
                }
                const relativePath = path.relative(workspaceRoot, filePath);

                let packageName = "your_project_name";
                try {
                  const pubspecPath = path.join(workspaceRoot, "pubspec.yaml");
                  if (fs.existsSync(pubspecPath)) {
                    const pubspecContent = fs.readFileSync(
                      pubspecPath,
                      "utf-8"
                    );
                    const nameMatch = pubspecContent.match(/name:\s+([^\s]+)/);
                    if (nameMatch && nameMatch[1]) {
                      packageName = nameMatch[1].trim();
                    }
                  }
                } catch (err) {
                  console.error("Error reading pubspec.yaml:", err);
                }
                const importPathTemp = `package:${packageName}/${relativePath}`;

                const importPath = `package:${packageName}/${relativePath
                  .replace(/\\/g, "/")
                  .replace("lib/", "")}`;
                const testCode = generateModelTest(
                  models,
                  importPath,
                  testFileContent
                );

                const testFilePath = filePath
                  .replace(".dart", "_test.dart")
                  .replace(
                    path.join(workspaceRoot, "lib"),
                    path.join(workspaceRoot, "test")
                  );

                const testDir = path.dirname(testFilePath);
                fs.mkdirSync(testDir, { recursive: true });

                if (!fs.existsSync(testFilePath)) {
                  fs.writeFileSync(testFilePath, testCode);
                  successCount++;
                } else {
                  const response = await vscode.window.showWarningMessage(
                    `Test already exists for ${path.basename(
                      filePath
                    )}. Do you want to overwrite it?`,
                    "Yes",
                    "No"
                  );

                  if (response === "Yes") {
                    fs.writeFileSync(testFilePath, testCode);
                    successCount++;
                  }
                }
              } else {
                vscode.window.showWarningMessage(
                  `No model classes found in ${path.basename(filePath)}`
                );
              }

              processed++;

              await new Promise((resolve) => setTimeout(resolve, 10));
            } catch (error) {
              console.error(`Error processing ${filePath}:`, error);
              vscode.window.showErrorMessage(
                `Error processing ${path.basename(filePath)}: ${error}`
              );
            }
          }

          if (successCount > 0) {
            vscode.window.showInformationMessage(
              `Successfully generated ${successCount} test file${
                successCount > 1 ? "s" : ""
              }`
            );
          }
        }
      );
    }
  );
}

export async function registerModelGeneratorModule(
  context: vscode.ExtensionContext,
  allModels: ModelInfo[]
) {
  const folderContextUpdater = async (uri?: vscode.Uri) => {
    if (!uri) {
      const explorerSelection = vscode.window.activeTextEditor?.document.uri;
      if (explorerSelection) {
        uri = explorerSelection;
      } else {
        return;
      }
    }

    try {
      const stats = fs.statSync(uri.fsPath);

      if (stats.isDirectory()) {
        const hasModelFiles = await checkFolderContainsModelFiles(uri.fsPath);
        vscode.commands.executeCommand(
          "setContext",
          "dart-model-files-in-folder",
          hasModelFiles
        );
      } else if (
        stats.isFile() &&
        /model/i.test(path.basename(uri.fsPath)) &&
        /\.dart$/i.test(uri.fsPath)
      ) {
        vscode.commands.executeCommand(
          "setContext",
          "dart-model-files-in-folder",
          false
        );
      } else {
        const parentDir = path.dirname(uri.fsPath);
        const hasModelFiles = await checkFolderContainsModelFiles(parentDir);
        vscode.commands.executeCommand(
          "setContext",
          "dart-model-files-in-folder",
          hasModelFiles
        );
      }
    } catch (error) {
      console.error("Error checking file/folder context:", error);
      vscode.commands.executeCommand(
        "setContext",
        "dart-model-files-in-folder",
        false
      );
    }
  };

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => {
      folderContextUpdater();
    })
  );

  const watcher = vscode.workspace.createFileSystemWatcher("*.dart");
  context.subscriptions.push(
    watcher.onDidCreate(() => folderContextUpdater()),
    watcher.onDidDelete(() => folderContextUpdater()),
    watcher
  );

  folderContextUpdater();

  const modelDisposable = await registerModelGeneratorCommand(allModels);

  context.subscriptions.push(modelDisposable);
}
