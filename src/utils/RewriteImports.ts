/**
 * Uses the acorn.js library to parse a script's code into an AST and
 * recursively walk through that AST to replace import urls with blobs
 */
import * as walk from "acorn-walk";
import { parse } from "acorn";

import { Player } from "../Player";
import { Script } from "../Script/Script";
import { GetAllServers } from "../Server/AllServers";
import { getAllParentDirectories, evaluateFilePath, areFilesEqual, areImportsEquals } from "../Terminal/DirectoryHelpers";

const comment = "// This import statement may be broken by a recent upgrade. Check the path to the script.";

// Migrate the current script using other scripts on the server.
//
// - script -- the script for whom we are getting a URL.
// - scripts -- all the scripts available on this server
//
// TODO We don't make any effort to cache a given module when it is imported at
// different parts of the tree. That hasn't presented any problem with during
// testing, but it might be an idea for the future. Would require a topo-sort
// then url-izing from leaf-most to root-most.
/**
 * @param {Script} script
 * @param {Script[]} scripts
 * @returns {string} The converted code with updated import statements
 */
function convert(script: Script, scripts: Script[]): string {
  const scriptDirectory = getAllParentDirectories(script.filename);
  const importNodes: Array<any> = [];

  try {
    // Parse the code into an ast tree
    const ast: any = parse(script.code, { sourceType: "module", ecmaVersion: "latest", ranges: true });

    // Walk the nodes of this tree and find any import declaration statements.
    walk.simple(ast, {
      ImportDeclaration(node: any) {
        // Push this import onto the stack to replace
        importNodes.push({ filename: node.source.value, start: node.source.range[0] + 1, end: node.source.range[1] - 1, statementStart: node.range[0], statementEnd: node.range[1] })
      }
    });
  }
  catch (err) {
    throw new Error("Error processing script for migration, parse error: " + err);
  }

  // Sort the nodes from last start index to first. This replaces the last import with a blob first,
  // preventing the ranges for other imports from being shifted.
  importNodes.sort((a, b) => b.start - a.start);
  let transformedCode = script.code;
  // Loop through each node and replace the script name with a blob url.
  for (const node of importNodes) {
    // The old style of import allowed for ./ to reference the root level.
    // Strip the ./ prefix if it exists and replace the import.
    let filename = node.filename;
    if (filename.startsWith("./"))
      filename = filename.substring(2);
    const matchingScripts = scripts.filter((s) => areImportsEquals(s.filename, filename));
    // If the file is found at the root level, replace it with the / syntax.
    // E.g. a file in Scripts/MyScript.js importing ./helpers.js would previously import /helpers.js
    // It should still import /helpers.js, so rewrite the import so the script still functions.
    if (matchingScripts.length !== 0) {
      const [matchingScript] = matchingScripts;
      const newFilename = evaluateFilePath("/" + matchingScript.filename);
      if (newFilename == node.filename) {
        // We already replace this or it is already valid.
        continue;
      }
      const orig = transformedCode.substring(node.statementStart, node.statementEnd);
      transformedCode = transformedCode.substring(0, node.start) + "/" + matchingScript.filename + transformedCode.substring(node.end);
      transformedCode = transformedCode.substring(0, node.statementStart) + "\n" +
        "// =============================== original line ===============================\n" + 
        "/**\n" +
        " * " + orig + "\n" +
        " */\n" +
        "// =============================================================================\n" +
        transformedCode.substring(node.statementStart);
      continue;
    }

    // Check the current directory
    filename = evaluateFilePath(node.filename, scriptDirectory) ||
      evaluateFilePath(node.filename + ".js", scriptDirectory);
    if (filename != null) {
      const rootMatchingScripts = scripts.filter((s) => areFilesEqual(s.filename, filename));
      if (rootMatchingScripts.length !== 0) {
        const [matchingScript] = rootMatchingScripts;
      const orig = transformedCode.substring(node.statementStart, node.statementEnd);
      transformedCode = transformedCode.substring(0, node.start) + matchingScript.filename + transformedCode.substring(node.end);
        transformedCode = transformedCode.substring(0, node.statementStart) + "\n" +
          "// =============================== original line ===============================\n" + 
          "/**\n" +
          " * " + orig + "\n" +
          " */\n" +
          "// =============================================================================\n" +
          transformedCode.substring(node.statementStart);
        continue;
      }
    }

    // Place the comment before this import.
    transformedCode = transformedCode.substring(0, node.statementStart) + "\n" + comment + "\n" + transformedCode.substring(0, node.statementStart);
  }

  return transformedCode;
}

export function rewriteImports(): void {
  let txt = "";
  for (const server of GetAllServers()) {
    const backups: Script[] = [];
    for (const script of server.scripts.filter((s) => s.filename.endsWith(".js") || s.filename.endsWith(".ns"))) {
      try {
        const code = convert(script, server.scripts);
        if (script.code === code) {
          // No change
          continue;
        }
        let backupFilename = script.filename;
        if (!backupFilename.startsWith("/"))
          backupFilename = "/" + backupFilename;
        backupFilename = "/BACKUP" + backupFilename;
        backups.push(new Script(backupFilename, script.code, script.server));
        script.code = code;
        txt += `// Changed import statements in ${script.filename} on ${server.hostname}`;
      }
      catch (err) {
        txt += `// Failed to convert ${script.filename} on ${server.hostname}, reason: ${err}` + "\n";
      }
    }
    server.scripts = server.scripts.concat(backups);
  }
  if (txt !== "") {
    const home = Player.getHomeComputer();
    home.writeToTextFile("IMPORT_DETECTED_CHANGES.txt", txt);
  }
}
