import js from "@eslint/js";
import tseslint from "typescript-eslint";
import vue from "eslint-plugin-vue";
import vueParser from "vue-eslint-parser";
import prettier from "eslint-config-prettier";
import prettierPlugin from "eslint-plugin-prettier";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

export default [
  // 1. Игнорируемые пути
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/coverage/**",
      "**/*.config.js",
      "**/*.config.ts",
      "docs/**",
    ],
  },

  // 2. Базовые правила JS
  js.configs.recommended,

  // 3. Правила TypeScript (общие для клиента и сервера)
  ...tseslint.configs.recommended,

  // 4. Главный блок — общие правила для всего монорепо
  {
    files: ["**/*.{js,mjs,cjs,ts,vue}"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: "module",
        // Явно указываем корень для парсера, чтобы он корректно резолвил
        // алиасы (@monopoly/shared) из обоих workspace-пакетов.
        tsconfigRootDir: __dirname,
        project: [
          "./apps/client/tsconfig.app.json",
          "./apps/client/tsconfig.node.json",
          "./apps/server/tsconfig.json",
          "./packages/shared/tsconfig.json",
        ],
      },
      globals: {
        // Общие для всего проекта
        console: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        process: "readonly",
        Buffer: "readonly",
        URL: "readonly",
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
      "@typescript-eslint/explicit-function-return-type": "off",
      "@typescript-eslint/explicit-module-boundary-types": "off",
      "no-console": ["warn", { allow: ["warn", "error", "info"] }],
      "no-debugger": "warn",
      "no-var": "error",
      "prefer-const": "error",
      eqeqeq: ["error", "always"],
    },
  },

  // 5. Vue-специфичные правила ТОЛЬКО для клиента
  {
    files: ["apps/client/**/*.{ts,vue}"],
    plugins: { vue },
    languageOptions: {
      parser: vueParser,
      parserOptions: {
        parser: tseslint.parser,
        extraFileExtensions: [".vue"],
        tsconfigRootDir: __dirname,
        project: [
          "./apps/client/tsconfig.app.json",
          "./apps/client/tsconfig.node.json",
          "./packages/shared/tsconfig.json",
        ],
      },
      globals: {
        // Браузерные
        window: "readonly",
        document: "readonly",
        localStorage: "readonly",
        sessionStorage: "readonly",
        fetch: "readonly",
        HTMLElement: "readonly",
        HTMLInputElement: "readonly",
        MouseEvent: "readonly",
      },
    },
    rules: {
      ...vue.configs["flat/recommended"].rules,
      "vue/multi-word-component-names": "off",
      "vue/no-v-html": "warn",
      "vue/html-self-closing": [
        "error",
        { html: { void: "always", normal: "always", component: "always" } },
      ],
    },
  },

  // 6. NestJS-специфичные правила ТОЛЬКО для сервера
  {
    files: ["apps/server/**/*.ts"],
    rules: {
      // Декораторы NestJS иногда требуют any
      "@typescript-eslint/no-explicit-any": "off",
      // process.env доступен только на сервере
      "no-process-env": "off",
      // Можно использовать console.log для дебага на старте
      "no-console": "off",
    },
  },

  // 7. Тесты
  {
    files: ["**/*.{test,spec}.ts", "**/test/**/*"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "no-console": "off",
    },
  },

  // 8. Prettier — ВСЕГДА последним!
  prettier,
  {
    plugins: { prettier: prettierPlugin },
    rules: {
      "prettier/prettier": ["warn", { endOfLine: "auto" }],
    },
  },
];
