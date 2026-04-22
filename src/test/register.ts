// Install a `vscode` module resolver that returns our test shim. Loaded via
// `node --require` before any test file so imports of "vscode" resolve to the
// shim without needing a real extension host.
import Module from "node:module";
import * as path from "node:path";

interface PatchableModule {
  _resolveFilename: (
    request: string,
    parent: NodeModule | null,
    isMain: boolean,
    options?: unknown,
  ) => string;
}

const shimPath = path.resolve(__dirname, "vscodeStub.js");
const mod = Module as unknown as PatchableModule;

const originalResolve = mod._resolveFilename;

mod._resolveFilename = function patched(
  request: string,
  parent: NodeModule | null,
  isMain: boolean,
  options?: unknown,
): string {
  if (request === "vscode") return shimPath;
  return originalResolve.call(this, request, parent, isMain, options);
};
