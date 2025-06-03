import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { ModelInfo } from "../modules/models_test_generator";

let allModels: ModelInfo[] = [];

export function setAllModels(models: ModelInfo[]) {
  allModels = models;
}

export function getAllModels(): ModelInfo[] {
  return allModels;
}

function extractModelInfo(
  fileContent: string,
  importPath: string
): ModelInfo[] {
  const modelClasses: ModelInfo[] = [];

  const classRegex = /class\s+(\w+)\s*{([^}]*)}/g;
  let classMatch;

  while ((classMatch = classRegex.exec(fileContent)) !== null) {
    const modelName = classMatch[1];
    const classBody = classMatch[2];

    const fields: Record<string, string> = {};
    const fieldMatches = [...classBody.matchAll(/(\w+\??)\s+(\w+);/g)];

    for (const match of fieldMatches) {
      const fieldType = match[1];
      const fieldName = match[2];
      fields[fieldName] = fieldType;
    }

    modelClasses.push({
      modelName,
      fields,
      importPath,
    });
  }
  return modelClasses;
}

export async function scanModelFiles() {
  allModels = [];

  const files = await vscode.workspace.findFiles("lib/**/*.{dart}");
  for (const file of files) {
    const fileName = file.path.toLowerCase();

    const doc = await vscode.workspace.openTextDocument(file);

    const classRegex = /class\s+(\w+)\s*(?!extends\s+(\w*Widget))\s*{([^}]*)}/g;
    if (!classRegex.exec(doc.getText())) continue;
    const workspaceFolders = vscode.workspace.workspaceFolders;
    let workspaceRoot = "";

    if (workspaceFolders && workspaceFolders.length > 0) {
      workspaceRoot = workspaceFolders[0].uri.fsPath;
    }
    const relativePath = path.relative(workspaceRoot, file.path.toLowerCase());

    let packageName = "your_project_name";
    try {
      const pubspecPath = path.join(workspaceRoot, "pubspec.yaml");
      if (fs.existsSync(pubspecPath)) {
        const pubspecContent = fs.readFileSync(pubspecPath, "utf-8");
        const nameMatch = pubspecContent.match(/name:\s+([^\s]+)/);
        if (nameMatch && nameMatch[1]) {
          packageName = nameMatch[1].trim();
        }
      }
    } catch (err) {
      console.error("Error reading pubspec.yaml:", err);
    }
    const importPathTemp = `package:${packageName}/${
      relativePath.split("lib/")[1]
    }`;
    const modelInfos = extractModelInfo(doc.getText(), importPathTemp);

    if (modelInfos.length > 0) {
      allModels.push(
        ...modelInfos.filter((el) => Object.keys(el.fields).length > 0)
      );
    }
  }
}
