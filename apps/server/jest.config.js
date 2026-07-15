/**
 * Jest-конфигурация для server.
 *
 * Используем `ts-jest` (вместо дефолтного babel-jest), чтобы
 * корректно обрабатывать синтаксис `import type { ... }`, который
 * Babel-трансформер не понимает без `@babel/preset-typescript`.
 *
 * Также подключаем `tsconfig-paths`, чтобы алиасы из `tsconfig.json`
 * (`@monopoly/shared`) работали и в тестах.
 */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  rootDir: ".",
  testRegex: ".*\\.spec\\.ts$",
  moduleNameMapper: {
    "^@monopoly/shared$": "<rootDir>/../../packages/shared/src/index.ts",
    "^@monopoly/shared/(.*)$": "<rootDir>/../../packages/shared/src/$1",
  },
  transform: {
    "^.+\\.ts$": [
      "ts-jest",
      {
        tsconfig: {
          // Используем минимальный конфиг, чтобы избежать rootDir
          // предупреждений и прочих конфликтов с основной сборкой.
          target: "ES2020",
          module: "commonjs",
          moduleResolution: "node",
          esModuleInterop: true,
          allowSyntheticDefaultImports: true,
          strict: false,
          experimentalDecorators: true,
          emitDecoratorMetadata: true,
          skipLibCheck: true,
          resolveJsonModule: true,
          types: ["jest", "node"],
        },
      },
    ],
  },
};
