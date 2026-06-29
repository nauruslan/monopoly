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

  // 2. Базовые JS-правила
  js.configs.recommended,

  // 3. Правила TypeScript
  ...tseslint.configs.recommended,

  // 4. Правила Vue (для .vue файлов)
  ...vue.configs["flat/recommended"],

  // 5. Главный блок конфигурации для всего монорепо
  {
    files: ["**/*.{js,mjs,cjs,ts,vue}"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      parser: vueParser,
      parserOptions: {
        parser: tseslint.parser,
        ecmaVersion: 2022,
        sourceType: "module",
        extraFileExtensions: [".vue"],
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
        // Браузерные глобальные переменные
        window: "readonly",
        document: "readonly",
        console: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        localStorage: "readonly",
        sessionStorage: "readonly",
        fetch: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
        HTMLElement: "readonly",
        HTMLInputElement: "readonly",
        MouseEvent: "readonly",
        // Node-глобалы (используются в apps/server)
        process: "readonly",
        Buffer: "readonly",
        __dirname: "readonly",
        __filename: "readonly",
        global: "readonly",
      },
    },
    rules: {
      // TypeScript-специфика
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],

      // Vue
      "vue/multi-word-component-names": "off",
      "vue/no-v-html": "warn",
      "vue/html-self-closing": [
        "error",
        { html: { void: "always", normal: "always", component: "always" } },
      ],

      // Общие правила чистоты
      "no-console": ["warn", { allow: ["warn", "error", "info"] }],
      "no-debugger": "warn",
      "no-var": "error",
      "prefer-const": "error",
      eqeqeq: ["error", "always"],
    },
  },

  // 6. Спец-блок для тестов
  {
    files: ["**/*.{test,spec}.ts", "**/test/**/*"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "no-console": "off",
    },
  },

  // 7. Prettier
  prettier,
  {
    plugins: { prettier: prettierPlugin },
    rules: {
      "prettier/prettier": ["warn", { endOfLine: "auto" }],
    },
  },
];