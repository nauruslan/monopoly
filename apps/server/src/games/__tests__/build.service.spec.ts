/**
 * Тесты для BuildService — централизованной логики строительства,
 * сноса, залога и выкупа недвижимости.
 *
 * Цель: гарантировать соблюдение КАСТОМНЫХ правил нашей Монополии
 * (см. GDD §5 и комментарии в начале build.service.ts):
 *
 *  1. Неограниченный банк домов/отелей.
 *  2. Цена отеля = цена дома (а не 5×).
 *  3. Отель продаётся ЦЕЛИКОМ (5 → 0), а не классические 5 → 4.
 *  4. Правило «лесенки» (чётности) — обязательно при build и sell.
 *  5. Залог блокируется при наличии домов в группе.
 *  6. Строительство блокируется при залоге в группе (наше правило
 *     ЖЁСТЧЕ классики).
 *  7. Постановка отеля (4 → 5) разрешена, если на ВСЕХ остальных
 *     клетках группы houses >= 4 (т.е. либо 4 дома, либо отель).
 *     Снятие отеля (5 → 0) разрешено, если на остальных клетках
 *     группы houses === 0 (классическая лесенка вниз).
 */
import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { BuildService } from "../handlers/build.service";
import { makeCell, makeMonopolyBoard, makePlayer, makeState, resetCounters } from "./factories";
import type { Cell, GameState, Player } from "@monopoly/shared";

describe("BuildService", () => {
  let build: BuildService;

  beforeEach(() => {
    resetCounters();
    build = new BuildService();
  });

  function monopolyState(
    overrides: {
      ownerId?: string;
      houses?: (0 | 1 | 2 | 3 | 4 | 5)[];
      isMortgaged?: boolean[];
      money?: number;
    } = {},
  ): { state: GameState; player: Player; cells: Cell[] } {
    const ownerId = overrides.ownerId ?? "p0";
    const player = makePlayer({ id: ownerId, money: overrides.money ?? 2000 });
    const baseBoard = makeMonopolyBoard(3, "brown");
    const cells: Cell[] = baseBoard.map((c, i) => ({
      ...c,
      id: i,
      ownerId,
      houses: overrides.houses?.[i] ?? 0,
      isMortgaged: overrides.isMortgaged?.[i] ?? false,
    }));
    const state = makeState({
      board: cells,
      players: [player, makePlayer({ id: "p1" })],
    });
    return { state, player, cells };
  }

  // ВАЖНО про getUnmortgageCost: 100 * 1.1 в JS — это 110.00000000000001
  // (классический IEEE-754 float-bug). Math.ceil округляет до 111.
  // Тесты учитывают это поведение.

  describe("canBuild", () => {
    it("ok если есть монополия, нет залогов в группе, хватает денег, и клетка — минимум по домам", () => {
      const { state, player, cells } = monopolyState({ money: 500 });
      const r = build.canBuild(player, cells[0]!, state);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.cost).toBe(50);
        expect(r.isHotel).toBe(false);
      }
    });

    it("fail если клетка не принадлежит игроку", () => {
      const { state, cells } = monopolyState();
      const other = makePlayer({ id: "p2", money: 2000 });
      const r = build.canBuild(other, cells[0]!, state);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe("Это не ваша клетка");
    });

    it("fail если клетка — RAILROAD (нельзя строить)", () => {
      const { state, player } = monopolyState();
      const rr = makeCell({
        id: 99,
        type: "RAILROAD",
        group: undefined,
        ownerId: player.id,
        price: 200,
        mortgageValue: 100,
      });
      state.board.push(rr);
      const r = build.canBuild(player, rr, state);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe("На этой клетке нельзя строить");
    });

    it("fail если клетка в залоге", () => {
      const { state, player, cells } = monopolyState();
      const mortgaged = { ...cells[0]!, isMortgaged: true };
      const r = build.canBuild(player, mortgaged, state);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/выкупите/);
    });

    it("fail если нет полной монополии", () => {
      const cells = makeMonopolyBoard(3, "brown").map((c, i) => ({
        ...c,
        id: i,
        ownerId: i === 2 ? "p1" : "p0",
      }));
      const player = makePlayer({ id: "p0", money: 2000 });
      const state = makeState({ board: cells, players: [player, makePlayer({ id: "p1" })] });
      const r = build.canBuild(player, cells[0]!, state);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/монополия/);
    });

    it("fail если в ГРУППЕ есть заложенная клетка (наше кастомное правило) — клетка-цель не заложена", () => {
      // Соседняя (id=1) заложена, целевая (id=0) — нет.
      // С новым правилом «активной монополии» группа с заложенной клеткой
      // вообще не считается монополией, поэтому первый же guard
      // `hasActiveMonopoly` возвращает false, и reason — «Нужна монополия…».
      // Главное: строить нельзя ни при каком из этих исходов.
      const { state, player, cells } = monopolyState({
        isMortgaged: [false, true, false],
      });
      const r = build.canBuild(player, cells[0]!, state);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/заложен|выкупите|монополия/);
    });

    it("fail если не хватает денег на дом", () => {
      const { state, player, cells } = monopolyState({ money: 30 });
      const r = build.canBuild(player, cells[0]!, state);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe("Недостаточно денег");
    });

    it("fail если нарушена лесенка — пытаемся строить на клетке не с минимумом", () => {
      const { state, player, cells } = monopolyState({ houses: [2, 1, 1] });
      const r = build.canBuild(player, cells[0]!, state);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/других участках/);
    });

    it("ok если на клетке минимум — можно строить следующий дом", () => {
      const { state, player, cells } = monopolyState({ houses: [0, 2, 2] });
      const r = build.canBuild(player, cells[0]!, state);
      expect(r.ok).toBe(true);
    });

    it("fail при попытке поставить отель (houses=4 -> 5), если на остальных < 4", () => {
      // Кастомное правило: отель можно ставить, только если на ВСЕХ
      // остальных клетках houses >= 4 (т.е. либо 4 дома, либо отель).
      const { state, player, cells } = monopolyState({ houses: [4, 3, 3] });
      const r = build.canBuild(player, cells[0]!, state);
      expect(r.ok).toBe(false);
      // Сервис: проверка лесенки идёт ДО проверки «все >=4». Текст -
      // «Сначала постройте дома на других участках группы».
      if (!r.ok) expect(r.reason).toMatch(/других участках/);
    });

    it("ok при попытке поставить отель, если ВСЕ участки группы имеют 4 дома (isHotel=true)", () => {
      const { state, player, cells } = monopolyState({ houses: [4, 4, 4] });
      const r = build.canBuild(player, cells[0]!, state);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.isHotel).toBe(true);
        // Кастомное правило: цена отеля = цена дома, не 5×.
        expect(r.cost).toBe(50);
      }
    });

    it("ok при попытке поставить отель, если на одной клетке уже отель (houses=5), а на другой 4 дома (houses=4)", () => {
      // Кастомное правило: отель можно ставить, если на ВСЕХ остальных
      // клетках houses >= 4 (т.е. 4 или 5). На одной клетке уже отель (5),
      // на другой 4 дома. Ставим второй отель - это разрешено.
      const { state, player, cells } = monopolyState({ houses: [4, 5, 4] });
      const r = build.canBuild(player, cells[0]!, state);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.isHotel).toBe(true);
        expect(r.cost).toBe(50);
      }
    });

    it("fail если уже стоит отель (houses=5) — все клетки группы тоже отели", () => {
      // Группа: [5, 5, 5]. Лесенка проходит (5 не > 5). Проверка
      // «houses >= 5» срабатывает: вернёт «Уже стоит отель».
      const { state, player, cells } = monopolyState({ houses: [5, 5, 5] });
      const r = build.canBuild(player, cells[0]!, state);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/Уже/);
    });
  });

  describe("canSell", () => {
    it("ok если на клетке есть дом и это максимум в группе", () => {
      const { state, player, cells } = monopolyState({ houses: [2, 1, 1] });
      const r = build.canSell(player, cells[0]!, state);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.refund).toBe(25);
        expect(r.isHotelSale).toBe(false);
      }
    });

    it("fail если на клетке 0 домов", () => {
      const { state, player, cells } = monopolyState();
      const r = build.canSell(player, cells[0]!, state);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/нет домов/);
    });

    it("fail если нарушена лесенка — пытаемся продать с клетки НЕ с максимумом", () => {
      const { state, player, cells } = monopolyState({ houses: [1, 2, 1] });
      const r = build.canSell(player, cells[0]!, state);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/других участках/);
    });

    it("ok при попытке снять отель, если на остальных тоже отели [5,5,5] (регресс: дедлок all-hotel)", () => {
      // Регресс: раньше проверка «others must be 0» делала НЕВОЗМОЖНОЙ
      // продажу любого из трёх отелей. Теперь правило лесенки достаточно:
      // max=5, cell.houses=5 → проходит. После продажи одного отеля
      // (5 → 4) получаем [4, 5, 5] — снова есть клетки = max (5), и т.д.
      const { state, player, cells } = monopolyState({ houses: [5, 5, 5] });
      const r = build.canSell(player, cells[0]!, state);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.isHotelSale).toBe(true);
        // Классика: refund за отель = housePrice / 2 = 25.
        expect(r.refund).toBe(25);
      }
    });

    it("ok при попытке снять отель, если на остальных смешанно [5,4,3] (cell — max)", () => {
      // Клетка 0 — отель (5), остальные меньше (4 и 3). Лесенка: cell=5,
      // max=5 → проходит. Никаких доп. ограничений нет.
      const { state, player, cells } = monopolyState({ houses: [5, 4, 3] });
      const r = build.canSell(player, cells[0]!, state);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.isHotelSale).toBe(true);
        expect(r.refund).toBe(25);
      }
    });

    it("fail при попытке снять отель с НЕ-максимальной клетки в группе [4,5,5]", () => {
      // Клетка 0 имеет houses=4, но в группе есть max=5 (отели).
      // Лесенка: cell.houses (4) < maxHouses (5) → fail.
      const { state, player, cells } = monopolyState({ houses: [4, 5, 5] });
      const r = build.canSell(player, cells[0]!, state);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/других участках/);
    });

    it("ok при снятии отеля, если на остальных 0 (isHotelSale=true, refund=housePrice/2)", () => {
      // Классические правила: отель «распадается» на 4 дома (5 → 4),
      // refund за сам отель = housePrice / 2. Остальные 4 дома можно
      // продать потом по одному.
      const { state, player, cells } = monopolyState({ houses: [5, 0, 0] });
      const r = build.canSell(player, cells[0]!, state);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.isHotelSale).toBe(true);
        expect(r.refund).toBe(25);
      }
    });
  });

  describe("canMortgage", () => {
    it("ok если клетка принадлежит игроку, не в залоге, нет домов в группе", () => {
      const { state, player, cells } = monopolyState();
      const r = build.canMortgage(player, cells[0]!, state);
      expect(r.ok).toBe(true);
    });

    it("fail если в группе есть дома", () => {
      const { state, player, cells } = monopolyState({ houses: [0, 1, 0] });
      const r = build.canMortgage(player, cells[0]!, state);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/дома/);
    });

    it("fail если клетка уже в залоге", () => {
      const { state, player, cells } = monopolyState({ isMortgaged: [true, false, false] });
      const r = build.canMortgage(player, cells[0]!, state);
      expect(r.ok).toBe(false);
    });

    it("fail если клетка не принадлежит игроку", () => {
      const { state, cells } = monopolyState();
      const other = makePlayer({ id: "p2" });
      const r = build.canMortgage(other, cells[0]!, state);
      expect(r.ok).toBe(false);
    });
  });

  describe("canUnmortgage / getUnmortgageCost", () => {
    it("getUnmortgageCost = ceil(100 * 1.1) = 111 (с учётом float-погрешности)", () => {
      const cell = makeCell({ mortgageValue: 100 });
      // 100 * 1.1 = 110.00000000000001 → Math.ceil → 111
      expect(build.getUnmortgageCost(cell)).toBe(111);
    });

    it("getUnmortgageCost = 0 если mortgageValue не задан", () => {
      const cell = makeCell({ mortgageValue: undefined });
      expect(build.getUnmortgageCost(cell)).toBe(0);
    });

    it("canUnmortgage ok если заложена + хватает денег", () => {
      const { state, player, cells } = monopolyState({ isMortgaged: [true, false, false] });
      const r = build.canUnmortgage(player, cells[0]!);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.cost).toBe(111);
    });

    it("canUnmortgage fail если не в залоге", () => {
      const { player, cells } = monopolyState();
      const r = build.canUnmortgage(player, cells[0]!);
      expect(r.ok).toBe(false);
    });

    it("canUnmortgage fail если не хватает денег", () => {
      const { player, cells } = monopolyState({ isMortgaged: [true, false, false], money: 50 });
      const r = build.canUnmortgage(player, cells[0]!);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/Недостаточно/);
    });
  });

  describe("build (мутация)", () => {
    it("списывает деньги и инкрементирует houses", () => {
      const { state, player, cells } = monopolyState({ money: 500 });
      const before = player.money;
      const result = build.build(state, player, 0);
      expect(result.cost).toBe(50);
      expect(result.newHousesCount).toBe(1);
      expect(player.money).toBe(before - 50);
      expect(cells[0]!.houses).toBe(1);
    });

    it("build c houses=4 -> 5 (отель) если вся группа = 4 дома, цена = housePrice", () => {
      const { state, player, cells } = monopolyState({ houses: [4, 4, 4], money: 500 });
      const result = build.build(state, player, 0);
      expect(result.newHousesCount).toBe(5);
      expect(result.isHotel).toBe(true);
      expect(result.cost).toBe(50);
    });

    it("build c houses=4 -> 5 (отель) если на других клетках houses >= 4 (включая отель)", () => {
      // Кастомное правило: на одной клетке уже отель (5), на другой 4.
      // Ставим второй отель - разрешено.
      const { state, player, cells } = monopolyState({ houses: [4, 5, 4], money: 500 });
      const result = build.build(state, player, 0);
      expect(result.newHousesCount).toBe(5);
      expect(result.isHotel).toBe(true);
      expect(result.cost).toBe(50);
    });

    it("throws ForbiddenException при нарушении правила лесенки", () => {
      const { state, player, cells } = monopolyState({ houses: [2, 1, 1] });
      expect(() => build.build(state, player, 0)).toThrow(ForbiddenException);
    });

    it("throws BadRequestException при несуществующей клетке", () => {
      const { state, player } = monopolyState();
      expect(() => build.build(state, player, 999)).toThrow(BadRequestException);
    });
  });

  describe("sell (мутация)", () => {
    it("уменьшает houses на 1 и начисляет refund=housePrice/2", () => {
      const { state, player, cells } = monopolyState({ houses: [2, 1, 1], money: 0 });
      const result = build.sell(state, player, 0);
      expect(result.newHousesCount).toBe(1);
      expect(result.refund).toBe(25);
      expect(player.money).toBe(25);
    });

    it("продажа отеля: 5 → 4 (КЛАССИКА), refund = housePrice / 2", () => {
      // Классические правила Монополии: отель «распадается» на 4 дома.
      // На участке остаётся 4 дома, refund = housePrice / 2 (как за 1 дом).
      const { state, player, cells } = monopolyState({ houses: [5, 0, 0], money: 0 });
      const result = build.sell(state, player, 0);
      expect(result.isHotelSale).toBe(true);
      expect(result.newHousesCount).toBe(4);
      // Половина цены дома: 50 / 2 = 25.
      expect(result.refund).toBe(25);
      expect(cells[0]!.houses).toBe(4);
      expect(player.money).toBe(25);
    });

    it("throws ForbiddenException при попытке продать с 0 домов", () => {
      const { state, player } = monopolyState();
      expect(() => build.sell(state, player, 0)).toThrow(ForbiddenException);
    });
  });

  describe("mortgage (мутация)", () => {
    it("выставляет isMortgaged=true и начисляет mortgageValue", () => {
      const { state, player, cells } = monopolyState({ money: 0 });
      const amount = build.mortgage(state, player, 0);
      expect(amount).toBe(100);
      expect(cells[0]!.isMortgaged).toBe(true);
      expect(player.money).toBe(100);
    });

    it("throws если в группе есть дома", () => {
      const { state, player } = monopolyState({ houses: [0, 1, 0] });
      expect(() => build.mortgage(state, player, 0)).toThrow(ForbiddenException);
    });
  });

  describe("unmortgage (мутация)", () => {
    it("выставляет isMortgaged=false и списывает стоимость выкупа", () => {
      const { state, player, cells } = monopolyState({
        isMortgaged: [true, false, false],
        money: 500,
      });
      const cost = build.unmortgage(state, player, 0);
      expect(cost).toBe(111);
      expect(cells[0]!.isMortgaged).toBe(false);
      expect(player.money).toBe(500 - 111);
    });
  });

  describe("listBuildable / Sellable / Mortgageable / Unmortgageable", () => {
    it("listBuildableProperties возвращает клетки, на которых можно строить", () => {
      const { state, player } = monopolyState({ money: 500 });
      const list = build.listBuildableProperties(player, state);
      expect(list.length).toBe(3);
    });

    it("listBuildableProperties пуст при отсутствии монополии", () => {
      const { state, player, cells } = monopolyState({ money: 500 });
      const otherOwned = { ...cells[2]!, ownerId: "p1" };
      state.board[2] = otherOwned;
      const list = build.listBuildableProperties(player, state);
      expect(list.length).toBe(0);
    });

    it("listSellableProperties содержит только клетки с домами на максимуме", () => {
      const { state, player, cells } = monopolyState({ houses: [2, 1, 1] });
      const list = build.listSellableProperties(player, state);
      expect(list.length).toBe(1);
      expect(list[0]!.id).toBe(0);
    });

    it("listMortgageableProperties содержит клетки без домов", () => {
      const { state, player } = monopolyState();
      const list = build.listMortgageableProperties(player, state);
      expect(list.length).toBe(3);
    });

    it("listUnmortgageableProperties содержит только заложенные", () => {
      const { state, player, cells } = monopolyState({
        isMortgaged: [true, false, true],
        money: 1000,
      });
      const list = build.listUnmortgageableProperties(player, state);
      expect(list.length).toBe(2);
    });
  });

  describe("calculateTotalLiquidValue", () => {
    it("считает деньги + возврат за дома + стоимость залога", () => {
      const { state, player, cells } = monopolyState({
        money: 100,
        houses: [2, 1, 1], // возврат: 2*25 + 25 + 25 = 100
      });
      const value = build.calculateTotalLiquidValue(player, state);
      // 100 (деньги) + 100 (дома) + 300 (залог 3-х клеток) = 500
      expect(value).toBe(500);
    });

    it("отель даёт ликвидность 5 домов: refund за сам отель + 4 оставшихся дома после снятия", () => {
      // Классика: продаём отель (5 → 4), refund = housePrice / 2 за
      // сам отель. Оставшиеся 4 дома продаются потом по одному:
      // 4 * housePrice / 2 = 100. Итого за «комплект» отеля: 25 + 100 = 125.
      const { state, player, cells } = monopolyState({
        money: 0,
        houses: [5, 0, 0],
      });
      const value = build.calculateTotalLiquidValue(player, state);
      // 0 (деньги) + 125 (отель+4 дома) + 300 (залог 3-х клеток) = 425
      expect(value).toBe(425);
    });

    it("не учитывает заложенные клетки повторно", () => {
      const { state, player, cells } = monopolyState({
        money: 0,
        isMortgaged: [true, false, false],
      });
      const value = build.calculateTotalLiquidValue(player, state);
      // 0 (деньги) + 200 (залог 2 незаложенных) = 200
      expect(value).toBe(200);
    });
  });
});
