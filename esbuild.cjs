const esbuild = require("esbuild");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

// The webviews always need bundling: they run inside a browser context that
// can't execute TypeScript. In development the extension host loads
// src/extension.ts directly (Node's native type stripping, package.json
// "type": "module"); --production also bundles it and the detached agent host
// for the vsix (see `make prod`), so it ships no node_modules.

/**
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
  name: "esbuild-problem-matcher",

  setup(build) {
    build.onStart(() => {
      console.log("[watch] build started");
    });
    build.onEnd(result => {
      result.errors.forEach(({ text, location }) => {
        console.error(`✘ [ERROR] ${text}`);
        console.error(
          `    ${location?.file}:${location?.line}:${location?.column}:`,
        );
      });
      console.log("[watch] build finished");
    });
  },
};

function webviewBuildOptions(entryPoint, outfile) {
  return {
    entryPoints: [entryPoint],
    bundle: true,
    format: "iife",
    minify: production,
    // Kept out of the vsix by `make prod`; there to decode stack traces.
    sourcemap: true,
    sourcesContent: false,
    platform: "browser",
    outfile,
    logLevel: "silent",
    plugins: [esbuildProblemMatcherPlugin],
  };
}

function nodeBuildOptions(entryPoint, outfile) {
  return {
    ...webviewBuildOptions(entryPoint, outfile),
    format: "esm",
    platform: "node",
    target: "node22",
    external: ["vscode"],
    // CommonJS dependencies (ws) call require(), which an ESM bundle lacks.
    banner: {
      js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
    },
  };
}

async function main() {
  const contexts = await Promise.all([
    esbuild.context(
      webviewBuildOptions("src/webview/sessionView.ts", "dist/sessionView.js"),
    ),
    ...(production
      ? [
          esbuild.context(
            nodeBuildOptions("src/extension.ts", "dist/extension.js"),
          ),
          esbuild.context(
            nodeBuildOptions("src/ahp/hostMain.ts", "dist/ahp/hostMain.js"),
          ),
        ]
      : []),
  ]);
  if (watch) {
    await Promise.all(contexts.map(ctx => ctx.watch()));
  } else {
    await Promise.all(contexts.map(ctx => ctx.rebuild()));
    await Promise.all(contexts.map(ctx => ctx.dispose()));
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
