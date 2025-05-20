import * as fs from "fs";
import * as path from "path";

function findModelFiles(libDir: string): string[] {
  const modelFiles: string[] = [];
  const walk = (dir: string) => {
    const files = fs.readdirSync(dir);
    for (const file of files) {
      const filePath = path.join(dir, file);
      const stat = fs.statSync(filePath);
      if (stat.isDirectory()) {
        walk(filePath);
      } else if (
        file.toLowerCase().includes("model") &&
        file.endsWith(".dart")
      ) {
        modelFiles.push(filePath);
      }
    }
  };
  walk(libDir);
  return modelFiles;
}

function isClassData(fieldType: string): boolean {
  if (
    ["String", "int", "bool", "double", "dynamic"].some((type) =>
      fieldType.includes(type)
    )
  ) {
    return false;
  }
  return !!fieldType;
}