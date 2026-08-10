/**
 * Fisher-Yates shuffle — детерминированный алгоритм перемешивания.
 *
 * ВАЖНО:
 *  - НЕ мутирует входной массив (создаёт копию);
 *  - принимает инъектируемый {@link Rng};
 *  - O(n) по времени и памяти.
 */
import type { Rng } from "./rng";

/**
 * Возвращает новый массив, содержащий те же элементы в случайном порядке.
 *
 * @param arr входной массив (не мутируется)
 * @param rng инъектируемый генератор случайных чисел
 * @returns новый массив той же длины
 *
 * @example
 * ```ts
 * const rng = createRng("test-seed");
 * const shuffled = fisherYates([1, 2, 3, 4, 5], rng);
 * // shuffled — новый массив, например [3, 1, 5, 2, 4]
 * ```
 */
export function fisherYates<T>(arr: readonly T[], rng: Rng): T[] {
  // Создаём копию, чтобы не мутировать вход.
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    // nextInt(i + 1) даёт индекс в [0, i].
    const j = rng.nextInt(i + 1);
    const tmp = a[i]!;
    a[i] = a[j]!;
    a[j] = tmp;
  }
  return a;
}

/**
 * Выбирает случайное подмножество размера `k` из `arr` БЕЗ замены.
 *
 * Используется в `setupDecks`:
 *  - если `templates.length > cardCount`, берём случайное подмножество;
 *  - если `templates.length <= cardCount`, см. {@link sampleWithReplacement}.
 *
 * @param arr входной массив
 * @param k размер подмножества (должен быть <= arr.length)
 * @param rng RNG
 * @returns новый массив длины k
 */
export function sampleWithoutReplacement<T>(arr: readonly T[], k: number, rng: Rng): T[] {
  if (k < 0) throw new RangeError(`k must be non-negative, got ${k}`);
  if (k > arr.length) {
    throw new RangeError(`k (${k}) cannot exceed arr.length (${arr.length})`);
  }
  if (k === 0) return [];
  // Перемешиваем копию и берём первые k элементов.
  return fisherYates(arr, rng).slice(0, k);
}

/**
 * Выбирает `k` элементов из `arr` С заменой (возможны дубли).
 *
 * Используется в `setupDecks`, когда `templates.length < cardCount`
 * и `allowDuplicates = true`.
 *
 * @param arr входной массив
 * @param k количество элементов (должно быть > 0)
 * @param rng RNG
 * @returns новый массив длины k (возможно с дубликатами)
 */
export function sampleWithReplacement<T>(arr: readonly T[], k: number, rng: Rng): T[] {
  if (k < 0) throw new RangeError(`k must be non-negative, got ${k}`);
  if (arr.length === 0) {
    throw new RangeError("Cannot sample from empty array");
  }
  const result: T[] = [];
  for (let i = 0; i < k; i++) {
    result.push(arr[rng.nextInt(arr.length)]!);
  }
  return result;
}
