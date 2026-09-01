"use strict";

const globals = require("globals");

module.exports = [
  {
    files: ["src/**/*.js", "test/**/*.js"],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.es2022,
      },
      parserOptions: { ecmaVersion: 2022, sourceType: "commonjs" },
    },
    rules: {
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-console": "off",
      semi: ["error", "always"],
      quotes: ["error", "single"],
      indent: ["error", 2],
      eqeqeq: ["error", "always"],
      "no-var": "error",
      "prefer-const": ["error", { destructuring: "any", ignoreReadBeforeAssign: false }],
      "no-shadow": "error",
      "no-redeclare": "error",
      "object-curly-spacing": ["error", "always"],
      "array-bracket-spacing": ["error", "never"],
      "block-spacing": ["error", "always"],
      "key-spacing": ["error", { beforeColon: false, afterColon: true }],
      "keyword-spacing": ["error", { before: true, after: true }],
      "space-before-blocks": ["error", "always"],
      "comma-dangle": ["error", "always"],
      "consistent-return": "error",
      "no-multiple-empty-lines": ["error", { max: 2, maxEOF: 1 }],
    },
  },
  {
    ignores: ["node_modules/", "dist/", "*.lock", "data/", ".env"],
  },
];