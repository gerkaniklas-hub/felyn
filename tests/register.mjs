// Lets `node --test` run the app's TypeScript modules directly (Node 24 strips
// types natively): resolves the "@/..." alias and extensionless relative
// imports to the .ts/.tsx file, the way the Next.js bundler does. Node
// cannot strip JSX, so .tsx files (the React Email templates in src/emails/)
// are compiled with the project's own TypeScript, like tsconfig's
// "jsx": "react-jsx". No extra dependencies. Used by `npm test` only.
import { existsSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

registerHooks({
  resolve(specifier, context, nextResolve) {
    let candidate = null;
    if (specifier.startsWith("@/")) {
      candidate = path.join(root, "src", specifier.slice(2));
    } else if ((specifier.startsWith("./") || specifier.startsWith("../")) && context.parentURL?.startsWith("file:")) {
      candidate = path.resolve(path.dirname(fileURLToPath(context.parentURL)), specifier);
    }
    if (candidate && !/\.[cm]?[jt]sx?$/.test(candidate)) {
      for (const suffix of [".ts", ".tsx", path.join(path.sep, "index.ts")]) {
        if (existsSync(candidate + suffix)) return nextResolve(pathToFileURL(candidate + suffix).href, context);
      }
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (!url.startsWith("file:") || !url.endsWith(".tsx")) return nextLoad(url, context);
    const { outputText } = ts.transpileModule(readFileSync(fileURLToPath(url), "utf8"), {
      fileName: fileURLToPath(url),
      compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    });
    return { format: "module", source: outputText, shortCircuit: true };
  },
});
