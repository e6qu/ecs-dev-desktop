// SPDX-License-Identifier: AGPL-3.0-or-later
import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/.next/**",
      "**/node_modules/**",
      "**/.turbo/**",
      "**/coverage/**",
      "**/*.config.*",
      "**/next-env.d.ts",
    ],
  },
  {
    files: ["**/*.{ts,tsx}"],
    extends: [
      js.configs.recommended,
      ...tseslint.configs.strictTypeChecked,
      ...tseslint.configs.stylisticTypeChecked,
    ],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // No ts-ignore/ts-nocheck; ts-expect-error only with a written reason.
      "@typescript-eslint/ban-ts-comment": [
        "error",
        { "ts-ignore": true, "ts-nocheck": true, "ts-expect-error": "allow-with-description" },
      ],
      // Casts are exceptional; never assert object literals.
      "@typescript-eslint/consistent-type-assertions": [
        "error",
        { assertionStyle: "as", objectLiteralTypeAssertions: "never" },
      ],
      // Numbers in template strings are fine (e.g. ports).
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],
      // Ban the bare `object` type.
      "no-restricted-syntax": [
        "error",
        {
          selector: "TSObjectKeyword",
          message: "Use a precise type or Record<string, unknown>, not 'object'.",
        },
      ],
    },
  },
  // Disable stylistic rules that conflict with Prettier (Prettier owns formatting).
  prettier,
);
