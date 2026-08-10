/**
 * Barrel-файл модуля колод.
 *
 * Реэкспортирует публичный API для удобного импорта:
 *   import { createRng, fisherYates, CardInstance } from "@monopoly/server/games/decks";
 */
export * from "./types";
export * from "./errors";
export * from "./rng";
export * from "./shuffle";
