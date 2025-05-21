// // Import required modules
// import * as fs from 'fs';
// import * as path from 'path';

// const re = require('regex');

// function parse_method_line(line: string): [string | null, string | null, string[] | null] {
//     const methodRegex = /Future<(\w+)?\??> (\w+)\((.*)\)/;
//     const match = line.split("async")[0].match(methodRegex);
//     if (match) {
//         const [, returnType, methodName, params] = match;
//         const paramsList = params ? params.split(",").map(p => p.trim()) : [];
//         return [returnType, methodName, paramsList];
//     }
//     return [null, null, null];
// }

// function parse_http_method(instanceName: string | null, line: string): [string | null, string | null] {
//     const match = line.match(/\.(post|get|put|delete)\(/);
//     return match ? [match[1], instanceName] : [null, null];
// }

// function extract_instance_name(line: string): string | null {
//     const match = line.match(/getIt<Dio>\(instanceName: (\w+)\)/);
//     return match ? match[1] : null;
// }

// function process_file(filePath: string) {
//     let dataSourceName: string | null = null;
//     const methods: any[] = [];
//     let instanceName: string | null = null;
//     let tempLine = "";
//     let nextAdd = false;
//     let nowRead = false;

//     const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
//     for (const line of lines) {
//         if (line.includes('abstract class')) {
//             const match = line.match(/abstract class (\w+)/);
//             if (match) dataSourceName = match[1];
//             nowRead = false;
//         }
//         if (nowRead) {
//             if (nextAdd) {
//                 tempLine += " " + line.trim();
//                 if (line.trim().endsWith(";")) {
//                     const [returnType, methodName, params] = parse_method_line(tempLine);
//                     instanceName = extract_instance_name(tempLine);
//                     const [httpMethod, _] = parse_http_method(instanceName, tempLine);
//                     tempLine = "";
//                     nextAdd = false;
//                     if (returnType && methodName) {
//                         methods.push({ method_name: methodName, return_type: returnType, params, http_method: httpMethod, instance_name: instanceName });
//                     }
//                 }
//             }
//         }
//         if (line.includes("@override")) nextAdd = true;
//         if (line.includes("}")) nowRead = true;
//     }

//     if (dataSourceName && methods.length) {
//         return {
//             data_source_name: dataSourceName,
//             data_source_file_name: path.basename(filePath).replace(".dart", ""),
//             methods
//         };
//     }
//     return null;
// }

// function find_data_source_files(directory: string): string[] {
//     const files: string[] = [];
//     const walk = (dir: string) => {
//         fs.readdirSync(dir).forEach(file => {
//             const fullPath = path.join(dir, file);
//             if (fs.statSync(fullPath).isDirectory()) {
//                 walk(fullPath);
//             } else if (file.toLowerCase().includes("data_source") && file.endsWith(".dart")) {
//                 files.push(fullPath);
//             }
//         });
//     };
//     walk(directory);
//     return files;
// }

// function process_project_lib_data_source(directory: string, lib: string) {
//     const libFolder = path.join(directory, lib);
//     const dataSources: any[] = [];
//     const dartFiles = find_data_source_files(libFolder);
//     for (const filePath of dartFiles) {
//         const dataSource = process_file(filePath);
//         if (dataSource) dataSources.push(dataSource);
//     }
//     return { data_sources: dataSources };
// }

// function extract_data_source_methods(jsonData: any, dataSourceName: string) {
//     for (const dataSource of jsonData.data_sources) {
//         if (dataSource.data_source_file_name === dataSourceName.replace(".dart", "")) {
//             const methods: any = {};
//             for (const method of dataSource.methods) {
//                 methods[method.method_name] = {
//                     return_type: method.return_type,
//                     params: method.params,
//                     instance_name: method.instance_name,
//                     http_method: method.http_method
//                 };
//             }
//             return [dataSource.data_source_name, methods];
//         }
//     }
//     return null;
// }

// function clean_interface_name(interfaceName: string): string {
//     return interfaceName.startsWith('I') ? interfaceName.slice(1) : interfaceName;
// }