import * as vscode from "vscode";
import {
  ModelInfo,
  registerModelGeneratorModule,
} from "./modules/models_test_generator";
import { scanModelFiles } from "./utils/model_utils";

var allModels: ModelInfo[] = [];

export async function activate(context: vscode.ExtensionContext) {
  await scanModelFiles();
  await registerModelGeneratorModule(context, allModels);
}

export function deactivate() {}
