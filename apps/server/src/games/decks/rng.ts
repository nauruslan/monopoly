/**
 * Инъектируемая абстракция над RNG.
 *
 * ЗАЧЕМ:
 *  - `Math.random()` ЗАПРЕЩЁН в бизнес-логике;
 *  - для тестируемости RNG должен быть подменяемым (fake-генератор);
 *  - для воспроизводимости партий — детерминированный seed.
 *
 * Использует пакет `seedrandom` (уже в зависимостях `@monopoly/server`),
 * но оборачивает его в собственный интерфейс, чтобы:
 *  1) не зависеть от API seedrandom напрямую (можно подменить в тестах);
 *  2) хранить seed в одном месте для детерминированного replay.
 */
import seedrandom from "seedrandom";

/**
 * Интерфейс инъектируемого генератора случайных чисел.
 *
 * Реализация: см. {@link createRng}.
 */
export interface Rng {
  /**
   * Возвращает следующее случайное число в диапазоне `[0, 1)`.
   * Распределение зависит от реализации (по умолчанию — равномерное).
   */
  next(): number;
  /**
   * Возвращает seed, использованный для инициализации.
   * Полезно для логирования и отладки.
   */
  readonly seed: string;
  /**
   * Возвращает целое число в диапазоне `[0, max)` (для удобства).
   * Использует {@link Rng.next} и округление вниз (как в Fisher-Yates).
   *
   * ВНИМАНИЕ: при `max <= 0` или `max === undefined` бросает ошибку.
   */
  nextInt(max: number): number;
}

/**
 * Создаёт инъектируемый RNG на основе `seedrandom`.
 *
 * @param seed строка, используемая как seed. Если пустая / не задана,
 *             генерируется случайный seed (uuid-подобный на основе
 *             `Math.random()` + `Date.now()`). НО: `Math.random` здесь
 *             допустим, потому что это ЕДИНСТВЕННОЕ место в DeckModule,
 *             где он используется — и только для генерации самого seed,
 *             а не для игровой логики.
 */
export function createRng(seed?: string): Rng {
  const resolvedSeed =
    seed && seed.length > 0 ? seed : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const generator = seedrandom(resolvedSeed);

  return {
    seed: resolvedSeed,
    next: () => generator(),
    nextInt(max: number): number {
      if (!Number.isFinite(max) || max <= 0) {
        throw new RangeError(`Rng.nextInt: max must be a positive finite number, got ${max}`);
      }
      return Math.floor(generator() * max);
    },
  };
}

/**
 * Fake-RNG для тестов: позволяет явно задавать последовательность
 * возвращаемых значений. После исчерпания — всегда `0`.
 */
export class FakeRng implements Rng {
  private readonly values: number[];
  private index = 0;
  public readonly seed: string;

  constructor(values: number[], seed: string = "fake-rng") {
    this.values = values;
    this.seed = seed;
  }

  next(): number {
    if (this.index >= this.values.length) return 0;
    const v = this.values[this.index]!;
    this.index += 1;
    return v;
  }

  nextInt(max: number): number {
    return Math.floor(this.next() * max);
  }
}

/**
 * Детерминированная генерация короткого id через RNG.
 */
export function randomId(rng: Rng) {
  let s = "";
  for (let i = 0; i < 8; i++) {
    s += rng.nextInt(16).toString(16);
  }
  return s;
}
