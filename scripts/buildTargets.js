const path = require("path");

// The fork ships only to Sonacove's meet client, so its bundles target the
// browsers meet supports: `modernTargets` in apps/meet/vite.config.js
// (edge>=79, firefox>=67, chrome>=64, safari>=12, iOS>=12). Keep the two in sync.
const BROWSER_TARGETS = [
  "chrome64",
  "edge79",
  "firefox67",
  "safari12",
  "ios12",
];

// Each package script runs with the package directory as its cwd. Naming the
// tsconfig stops esbuild from discovering one in every ancestor directory,
// which in Sonacove includes the host app's own tsconfig.json.
const packageTsconfig = () => path.resolve("tsconfig.json");

module.exports = { BROWSER_TARGETS, packageTsconfig };
