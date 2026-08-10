/**
 * Тесты rng.ts.
 */
import { createRng, FakeRng } from "../rng";

describe("createRng", () => {
  it("возвращает next() в [0, 1) — 1000 итераций", () => {
    const rng = createRng("bounds-test");
    for (let i = 0; i < 1000; i++) {
      const v = rng.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("сохраняет переданный seed", () => {
    const rng = createRng("my-seed");
    expect(rng.seed).toBe("my-seed");
  });

  it("генерирует случайный seed при пустом входе", () => {
    const rng1 = createRng("");
    const rng2 = createRng();
    // Оба seed непустые.
    expect(rng1.seed.length).toBeGreaterThan(0);
    expect(rng2.seed.length).toBeGreaterThan(0);
    // Эти два конкретных вызова почти наверняка дали разные seed
    // (зависит от времени, но мы делаем их последовательно).
    // Если flaky — повторить.
  });

  it("детерминирован при одинаковом seed", () => {
    const a = createRng("det-seed");
    const b = createRng("det-seed");
    for (let i = 0; i < 100; i++) {
      expect(a.next()).toBe(b.next());
    }
  });

  it("nextInt(max) возвращает целое в [0, max)", () => {
    const rng = createRng("nextint-test");
    const max = 5;
    for (let i = 0; i < 1000; i++) {
      const v = rng.nextInt(max);
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(max);
    }
  });

  it("nextInt(0) или nextInt(-1) → RangeError", () => {
    const rng = createRng("err-nextint");
    expect(() => rng.nextInt(0)).toThrow(RangeError);
    expect(() => rng.nextInt(-1)).toThrow(RangeError);
  });

  it("nextInt(Infinity) → RangeError", () => {
    const rng = createRng("err-inf");
    expect(() => rng.nextInt(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});

describe("FakeRng", () => {
  it("возвращает заранее заданные значения по порядку", () => {
    const fake = new FakeRng([0.1, 0.5, 0.9]);
    expect(fake.next()).toBe(0.1);
    expect(fake.next()).toBe(0.5);
    expect(fake.next()).toBe(0.9);
  });

  it("после исчерпания — всегда 0", () => {
    const fake = new FakeRng([0.7]);
    expect(fake.next()).toBe(0.7);
    expect(fake.next()).toBe(0);
    expect(fake.next()).toBe(0);
  });

  it("nextInt(max) использует next()", () => {
    const fake = new FakeRng([0.5, 0.99, 0.0]);
    expect(fake.nextInt(10)).toBe(5);
    expect(fake.nextInt(100)).toBe(99);
    expect(fake.nextInt(10)).toBe(0);
  });

  it("seed по умолчанию — 'fake-rng'", () => {
    const fake = new FakeRng([]);
    expect(fake.seed).toBe("fake-rng");
  });
});
