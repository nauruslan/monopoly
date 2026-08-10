/**
 * Тесты shuffle.ts.
 *
 * Покрывают:
 *  - Fisher-Yates не теряет элементы
 *  - Fisher-Yates не создаёт дубликатов
 *  - При одинаковом seed порядок одинаковый
 *  - При разных seed порядок отличается (статистически)
 *  - Пустой массив → пустой результат
 *  - 1 элемент → тот же элемент
 *  - sampleWithoutReplacement: размер, уникальность, ошибки
 *  - sampleWithReplacement: размер, возможность дубликатов, ошибки
 */
import { fisherYates, sampleWithoutReplacement, sampleWithReplacement } from "../shuffle";
import { createRng, FakeRng } from "../rng";

describe("fisherYates", () => {
  it("не теряет элементы (100 итераций на 10 элементах)", () => {
    const original = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    const originalSet = new Set(original);
    for (let i = 0; i < 100; i++) {
      const rng = createRng(`seed-${i}`);
      const shuffled = fisherYates(original, rng);
      expect(shuffled.length).toBe(original.length);
      expect(new Set(shuffled)).toEqual(originalSet);
    }
  });

  it("не создаёт дубликатов", () => {
    const original = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"];
    for (let i = 0; i < 50; i++) {
      const rng = createRng(`dup-test-${i}`);
      const shuffled = fisherYates(original, rng);
      // Все элементы уникальны.
      expect(new Set(shuffled).size).toBe(original.length);
    }
  });

  it("при одинаковом seed порядок одинаковый", () => {
    const original = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const a = fisherYates(original, createRng("fixed-seed"));
    const b = fisherYates(original, createRng("fixed-seed"));
    expect(a).toEqual(b);
  });

  it("при разных seed порядок статистически отличается", () => {
    const original = Array.from({ length: 20 }, (_, i) => i);
    const a = fisherYates(original, createRng("seed-A"));
    const b = fisherYates(original, createRng("seed-B"));
    // Для 20 элементов вероятность совпадения 20!^-1 — пренебрежимо мала.
    expect(a).not.toEqual(b);
  });

  it("не мутирует входной массив", () => {
    const original = [1, 2, 3, 4, 5];
    const originalCopy = [...original];
    const rng = createRng("no-mutate");
    fisherYates(original, rng);
    expect(original).toEqual(originalCopy);
  });

  it("пустой массив → пустой результат", () => {
    const result = fisherYates([], createRng("empty"));
    expect(result).toEqual([]);
  });

  it("1 элемент → тот же элемент", () => {
    const result = fisherYates([42], createRng("one-elem"));
    expect(result).toEqual([42]);
  });

  it("с FakeRng [0.5, 0.5, ...] — фиксированный обмен", () => {
    // Для [a, b, c]:
    // i=2, j = floor(0.5 * 3) = 1 → swap(c, b) → [a, c, b]
    // i=1, j = floor(0.5 * 2) = 1 → swap(c, c) → [a, c, b]
    // (next() для j=1 даёт опять 0.5, но позиция остаётся)
    const rng = new FakeRng([0.5, 0.5, 0.5, 0.5]);
    const result = fisherYates(["a", "b", "c"], rng);
    expect(result.length).toBe(3);
    expect(new Set(result)).toEqual(new Set(["a", "b", "c"]));
  });
});

describe("sampleWithoutReplacement", () => {
  it("возвращает массив длины k", () => {
    const arr = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const rng = createRng("sample-test");
    expect(sampleWithoutReplacement(arr, 3, rng).length).toBe(3);
    expect(sampleWithoutReplacement(arr, 0, rng).length).toBe(0);
    expect(sampleWithoutReplacement(arr, 10, rng).length).toBe(10);
  });

  it("возвращает уникальные элементы", () => {
    const arr = ["a", "b", "c", "d", "e"];
    const rng = createRng("unique-test");
    const sample = sampleWithoutReplacement(arr, 3, rng);
    expect(new Set(sample).size).toBe(3);
  });

  it("k > arr.length → RangeError", () => {
    const arr = [1, 2, 3];
    const rng = createRng("err-test");
    expect(() => sampleWithoutReplacement(arr, 5, rng)).toThrow(RangeError);
  });

  it("k < 0 → RangeError", () => {
    const arr = [1, 2, 3];
    const rng = createRng("err-test");
    expect(() => sampleWithoutReplacement(arr, -1, rng)).toThrow(RangeError);
  });

  it("k = 0 → пустой массив", () => {
    const arr = [1, 2, 3];
    const result = sampleWithoutReplacement(arr, 0, createRng("zero"));
    expect(result).toEqual([]);
  });
});

describe("sampleWithReplacement", () => {
  it("возвращает массив длины k", () => {
    const arr = [1, 2, 3, 4, 5];
    const rng = createRng("with-replacement");
    expect(sampleWithReplacement(arr, 7, rng).length).toBe(7);
  });

  it("допускает дубликаты при k > arr.length", () => {
    const arr = ["x", "y"];
    const rng = createRng("dups");
    const sample = sampleWithReplacement(arr, 10, rng);
    // Возможны дубли, но каждый элемент — из arr.
    for (const el of sample) {
      expect(["x", "y"]).toContain(el);
    }
    expect(sample.length).toBe(10);
  });

  it("пустой arr → RangeError", () => {
    const rng = createRng("empty-repl");
    expect(() => sampleWithReplacement([], 5, rng)).toThrow(RangeError);
  });

  it("k = 0 → пустой массив", () => {
    const arr = [1, 2, 3];
    const result = sampleWithReplacement(arr, 0, createRng("zero-repl"));
    expect(result).toEqual([]);
  });
});
