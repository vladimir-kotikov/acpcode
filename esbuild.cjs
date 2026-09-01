const esbuild = require("esbuild");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

// Only the webviews need bundling: they run inside a browser context that
// can't execute TypeScript. The extension host loads src/extension.ts
// directly (Node's native type stripping, package.json "type": "module").

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
          `    ${location.file}:${location.line}:${location.column}:`,
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
    sourcemap: !production,
    sourcesContent: false,
    platform: "browser",
    outfile,
    logLevel: "silent",
    plugins: [esbuildProblemMatcherPlugin],
  };
}

async function main() {
  const contexts = await Promise.all([
    esbuild.context(
      webviewBuildOptions("src/webview/main.ts", "dist/webview.js"),
    ),
    esbuild.context(
      webviewBuildOptions("src/webview/sessionView.ts", "dist/sessionView.js"),
    ),
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
