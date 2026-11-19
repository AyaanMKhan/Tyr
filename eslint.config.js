// ESLint flat config (PLANNING.md 2.19). `npm run lint`.
//
// typescript-eslint's recommended rules over cli/ and tests/, with Prettier
// owning formatting (eslint-config-prettier turns off the stylistic rules).
// Type-aware rules are left out on purpose: they would make `npm run lint`
// as slow as a full type check, and `npm run typecheck` already covers types.

import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
    { ignores: ["dist/", ".test-build/", "node_modules/", "docs/", ".claude/", ".tyr/"] },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
        files: ["**/*.ts", "**/*.js"],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: "module",
            globals: { ...globals.node },
        },
        rules: {
            // `_`-prefixed parameters and variables are deliberately unused.
            "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" }],
            // Terminal escape sequences are the point of the UI modules.
            "no-control-regex": "off",
            // `catch {}` with a comment explaining why is the house style for best-effort cleanup.
            "no-empty": ["error", { allowEmptyCatch: true }],
        },
    },
    {
        // Tests reach into loosely typed JSON and fake objects.
        files: ["tests/**/*.ts"],
        rules: {
            "@typescript-eslint/no-explicit-any": "off",
            "@typescript-eslint/no-non-null-assertion": "off",
            // Column-aligned output is asserted with literal runs of spaces, on purpose.
            "no-regex-spaces": "off",
        },
    },
    prettier,
);
