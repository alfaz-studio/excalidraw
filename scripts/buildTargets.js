const path = require("path");

// Each package script runs with the package directory as its cwd. Naming the
// tsconfig stops esbuild from discovering one in every ancestor directory,
// which in Sonacove includes the host app's own tsconfig.json.
const packageTsconfig = () => path.resolve("tsconfig.json");

module.exports = { packageTsconfig };
