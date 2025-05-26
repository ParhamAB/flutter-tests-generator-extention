import * as vscode from "vscode";
import {
  ModelInfo,
  registerModelGeneratorModule,
} from "./modules/models_test_generator";
import { scanModelFiles } from "./utils/model_utils";
import { registerDataSourceGeneratorModule } from "./modules/data_source_test_generator";

export async function activate(context: vscode.ExtensionContext) {
  await scanModelFiles();
  await registerModelGeneratorModule(context);
  await registerDataSourceGeneratorModule(context);
}

export function deactivate() {}
