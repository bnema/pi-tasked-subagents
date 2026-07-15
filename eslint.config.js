import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

const emptyProgramParser = {
  parseForESLint() {
    return {
      ast: {
        type: "Program",
        body: [],
        comments: [],
        tokens: [],
        sourceType: "module",
        range: [0, 0],
        loc: {
          start: { line: 1, column: 0 },
          end: { line: 1, column: 0 },
        },
      },
      scopeManager: null,
      visitorKeys: { Program: [] },
    };
  },
};

export default defineConfig(
  {
    ignores: ["node_modules/**", "coverage/**", "dist/**", "plans/**"],
  },
  {
    linterOptions: {
      reportUnusedDisableDirectives: "off",
    },
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.md", "**/*.json", "**/.gitignore", "**/LICENSE", "**/LICENSE.*"],
    languageOptions: {
      parser: emptyProgramParser,
    },
    rules: {},
  },
  {
    files: ["src/**/*.mjs", "scripts/**/*.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        console: "readonly",
        process: "readonly",
        URL: "readonly",
      },
    },
  },
  {
    files: ["extensions/**/*.ts", "src/**/*.ts", "tests/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "prefer-const": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },
);
