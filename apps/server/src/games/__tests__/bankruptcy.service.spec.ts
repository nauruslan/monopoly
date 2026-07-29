/**
 * Тесты BankruptcyService: новая логика продажи заложенных клеток при
 * ликвидации (фаза BANKRUPTCY_LIQUIDATE).
 *
 * Цель: убедиться, что заложенные клетки можно «допродать» Банку
 * за дополнительные 50% (mortgageValue), и что `computeMaxLiquidity`
 * учитывает эту ликвидность. Также проверяем, что `handle()` (полная
 * ликвидация) корректно очищает залог у клеток, передаваемых
 * кредитору.
 */
import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { BankruptcyService } from "../handlers/bankruptcy.service";
import { makeCell, makePlayer, makeState, resetCounters } from "./factories";

describe("BankruptcyService — продажа заложенных клеток (BANKRUPTCY_SELL_MORTGAGED_PROPERTY)", () => {
  let service: BankruptcyService;

  beforeEach(() => {
    resetCounters();
    service = new BankruptcyService();
  });

  describe("canSellMortgagedPropertyToBank", () => {
    it("возвращает true для заложенной клетки игрока с mortgageValue > 0", () => {
      const player = makePlayer({ id: "p0", money: -100 });
      const cell = makeCell({ id: 0, ownerId: "p0", isMortgaged: true, mortgageValue: 100 });
      const state = makeState({ board: [cell], players: [player] });

      expect(service.canSellMortgagedPropertyToBank(state, player, 0)).toBe(true);
    });

    it("возвращает false, если клетка не заложена", () => {
      const player = makePlayer({ id: "p0" });
      const cell = makeCell({ id: 0, ownerId: "p0", isMortgaged: false, mortgageValue: 100 });
      const state = makeState({ board: [cell], players: [player] });

      expect(service.canSellMortgagedPropertyToBank(state, player, 0)).toBe(false);
    });

    it("возвращает false, если клетка принадлежит другому игроку", () => {
      const player = makePlayer({ id: "p0" });
      const cell = makeCell({ id: 0, ownerId: "p1", isMortgaged: true, mortgageValue: 100 });
      const state = makeState({ board: [cell], players: [player] });

      expect(service.canSellMortgagedPropertyToBank(state, player, 0)).toBe(false);
    });

    it("возвращает false, если mortgageValue === 0", () => {
      const player = makePlayer({ id: "p0" });
      const cell = makeCell({
        id: 0,
        ownerId: "p0",
        isMortgaged: true,
        mortgageValue: 0,
      });
      const state = makeState({ board: [cell], players: [player] });

      expect(service.canSellMortgagedPropertyToBank(state, player, 0)).toBe(false);
    });

    it("возвращает false, если на клетке есть дома (защита)", () => {
      const player = makePlayer({ id: "p0" });
      const cell = makeCell({
        id: 0,
        ownerId: "p0",
        isMortgaged: true,
        mortgageValue: 100,
        houses: 2,
      });
      const state = makeState({ board: [cell], players: [player] });

      // По правилам Монополии на заложенной клетке не может быть домов,
      // но проверка остаётся как защита от рассинхрона.
      expect(service.canSellMortgagedPropertyToBank(state, player, 0)).toBe(false);
    });

    it("возвращает false, если клетка не существует", () => {
      const player = makePlayer({ id: "p0" });
      const state = makeState({ board: [], players: [player] });

      expect(service.canSellMortgagedPropertyToBank(state, player, 99)).toBe(false);
    });
  });

  describe("sellMortgagedPropertyToBank", () => {
    it("зачисляет mortgageValue игроку, очищает клетку (UNOWNED, isMortgaged=false)", () => {
      const player = makePlayer({ id: "p0", money: -100, properties: [0] });
      const cell = makeCell({
        id: 0,
        ownerId: "p0",
        isMortgaged: true,
        mortgageValue: 100,
        price: 200,
      });
      const state = makeState({ board: [cell], players: [player] });

      const value = service.sellMortgagedPropertyToBank(state, player, 0);

      expect(value).toBe(100);
      expect(player.money).toBe(0); // -100 + 100
      expect(player.properties).not.toContain(0);
      expect(cell.ownerId).toBeUndefined();
      expect(cell.isMortgaged).toBe(false);
      expect(cell.houses).toBe(0);
    });

    it("бросает ForbiddenException, если клетка не заложена", () => {
      const player = makePlayer({ id: "p0" });
      const cell = makeCell({ id: 0, ownerId: "p0", isMortgaged: false, mortgageValue: 100 });
      const state = makeState({ board: [cell], players: [player] });

      expect(() => service.sellMortgagedPropertyToBank(state, player, 0)).toThrow(
        ForbiddenException,
      );
    });

    it("бросает BadRequestException, если mortgageValue === 0", () => {
      const player = makePlayer({ id: "p0" });
      const cell = makeCell({
        id: 0,
        ownerId: "p0",
        isMortgaged: true,
        mortgageValue: 0,
      });
      const state = makeState({ board: [cell], players: [player] });

      expect(() => service.sellMortgagedPropertyToBank(state, player, 0)).toThrow(
        BadRequestException,
      );
    });

    it("бросает ForbiddenException, если клетка принадлежит другому игроку", () => {
      const player = makePlayer({ id: "p0" });
      const cell = makeCell({ id: 0, ownerId: "p1", isMortgaged: true, mortgageValue: 100 });
      const state = makeState({ board: [cell], players: [player] });

      expect(() => service.sellMortgagedPropertyToBank(state, player, 0)).toThrow(
        ForbiddenException,
      );
    });
  });

  describe("computeMaxLiquidity", () => {
    it("учитывает заложенные клетки по mortgageValue (дополнительные 50% номинала)", () => {
      const player = makePlayer({ id: "p0", money: 0, properties: [0, 1] });
      const c0 = makeCell({
        id: 0,
        ownerId: "p0",
        isMortgaged: true,
        mortgageValue: 100,
        price: 200,
      });
      const c1 = makeCell({
        id: 1,
        ownerId: "p0",
        isMortgaged: false,
        mortgageValue: 100,
        price: 200,
      });
      const state = makeState({ board: [c0, c1], players: [player] });

      const total = service.computeMaxLiquidity(state, player);
      // c0 (заложена) — допродажа: 100; c1 (не заложена) — продажа 100%: 200.
      // max() берёт максимум из {mortgage, price} для каждой клетки.
      expect(total).toBe(300);
    });

    it("учитывает дома и отели по половине housePrice", () => {
      const player = makePlayer({ id: "p0", money: 0, properties: [0] });
      const cell = makeCell({
        id: 0,
        ownerId: "p0",
        isMortgaged: false,
        houses: 2,
        housePrice: 100,
        price: 200,
        mortgageValue: 100,
      });
      const state = makeState({ board: [cell], players: [player] });

      // 2 дома * 50 + max(100, 200) = 100 + 200 = 300
      expect(service.computeMaxLiquidity(state, player)).toBe(300);
    });

    it("возвращает 0 для игрока без имущества", () => {
      const player = makePlayer({ id: "p0", money: -500 });
      const state = makeState({ board: [], players: [player] });
      expect(service.computeMaxLiquidity(state, player)).toBe(0);
    });
  });

  describe("canCoverDebt", () => {
    it("возвращает true, если залога + допродажи заложенных хватает на долг", () => {
      const player = makePlayer({ id: "p0", money: -250, properties: [0, 1] });
      const c0 = makeCell({
        id: 0,
        ownerId: "p0",
        isMortgaged: false,
        mortgageValue: 100,
        price: 200,
      });
      const c1 = makeCell({
        id: 1,
        ownerId: "p0",
        isMortgaged: true,
        mortgageValue: 100,
        price: 200,
      });
      const state = makeState({ board: [c0, c1], players: [player] });

      // max(0, -250) = 250; liquidity = 200 + 100 = 300; 300 >= 250 → true
      expect(service.canCoverDebt(state, player, 250)).toBe(true);
    });

    it("возвращает false, если даже заложенных клеток не хватает", () => {
      const player = makePlayer({ id: "p0", money: -1000, properties: [0] });
      const cell = makeCell({
        id: 0,
        ownerId: "p0",
        isMortgaged: true,
        mortgageValue: 100,
        price: 200,
      });
      const state = makeState({ board: [cell], players: [player] });

      // max(0, -1000) = 1000; liquidity = 100; 100 < 1000 → false
      expect(service.canCoverDebt(state, player, 1000)).toBe(false);
    });
  });

  describe("handle (полное банкротство) — правило: имущество → БАНК", () => {
    it("с кредитором: все клетки уходят в БАНК (UNOWNED, isMortgaged=false, houses=0)", () => {
      const player = makePlayer({ id: "p0", money: -50, properties: [0, 1] });
      const creditor = makePlayer({ id: "p1", money: 0, properties: [] });
      const c0 = makeCell({
        id: 0,
        ownerId: "p0",
        isMortgaged: true,
        mortgageValue: 100,
      });
      const c1 = makeCell({
        id: 1,
        ownerId: "p0",
        isMortgaged: false,
        houses: 2,
      });
      const state = makeState({
        board: [c0, c1],
        players: [player, creditor],
      });

      service.handle(state, player, creditor, 200);

      // ГЛАВНОЕ: клетки НЕ уходят кредитору, а уходят в БАНК.
      expect(c0.ownerId).toBeUndefined();
      expect(c0.isMortgaged).toBe(false);
      expect(c0.houses).toBe(0);
      expect(c1.ownerId).toBeUndefined();
      expect(c1.isMortgaged).toBe(false);
      expect(c1.houses).toBe(0);
      // Кредитор НЕ получает клетки.
      expect(creditor.properties).toEqual([]);
      // Игрок банкрот, его имущество и деньги обнулены.
      expect(player.properties).toEqual([]);
      expect(player.money).toBe(0);
      expect(player.isBankrupt).toBe(true);
    });

    it("с кредитором: кредитор получает компенсацию = debt от Банка", () => {
      const player = makePlayer({ id: "p0", money: -200, properties: [0] });
      const creditor = makePlayer({ id: "p1", money: 0, properties: [] });
      const c0 = makeCell({
        id: 0,
        ownerId: "p0",
        isMortgaged: true,
        mortgageValue: 100,
      });
      const state = makeState({
        board: [c0],
        players: [player, creditor],
      });

      service.handle(state, player, creditor, 200);

      // Кредитор получил 200 от Банка (исходный долг).
      expect(creditor.money).toBe(200);
      expect(player.money).toBe(0);
    });

    it("с кредитором: если player.money < 0, кредитор всё равно получает полный debt (Банк гарантирует)", () => {
      const player = makePlayer({ id: "p0", money: -500, properties: [0, 1] });
      const creditor = makePlayer({ id: "p1", money: 100, properties: [] });
      const c0 = makeCell({ id: 0, ownerId: "p0", mortgageValue: 50 });
      const c1 = makeCell({ id: 1, ownerId: "p0", mortgageValue: 30 });
      const state = makeState({
        board: [c0, c1],
        players: [player, creditor],
      });

      // После распродажи имущества у игрока осталось -500,
      // исходный долг = 500 (например, рента 500).
      service.handle(state, player, creditor, 500);

      // Кредитор получил 500 от Банка.
      expect(creditor.money).toBe(100 + 500);
      // Все клетки — в БАНК.
      expect(c0.ownerId).toBeUndefined();
      expect(c1.ownerId).toBeUndefined();
    });

    it("без кредитора: все клетки уходят в БАНК, деньги банкрота сгорают", () => {
      const player = makePlayer({ id: "p0", money: -50, properties: [0] });
      const c0 = makeCell({
        id: 0,
        ownerId: "p0",
        isMortgaged: true,
        mortgageValue: 100,
      });
      const state = makeState({ board: [c0], players: [player] });

      service.handle(state, player, null, 100);

      expect(c0.ownerId).toBeUndefined();
      expect(c0.isMortgaged).toBe(false);
      expect(c0.houses).toBe(0);
      expect(player.money).toBe(0);
      expect(player.properties).toEqual([]);
      expect(player.isBankrupt).toBe(true);
    });

    it("с кредитором: если debt=0 (без долга), компенсация не начисляется", () => {
      const player = makePlayer({ id: "p0", money: 100, properties: [0] });
      const creditor = makePlayer({ id: "p1", money: 0, properties: [] });
      const c0 = makeCell({ id: 0, ownerId: "p0" });
      const state = makeState({
        board: [c0],
        players: [player, creditor],
      });

      service.handle(state, player, creditor, 0);

      // Клетка в БАНК.
      expect(c0.ownerId).toBeUndefined();
      // Кредитору ничего не начислили (debt=0).
      expect(creditor.money).toBe(0);
    });

    it("вызывает условие победы, если остался один не обанкротившийся", () => {
      const p0 = makePlayer({ id: "p0", money: -50, properties: [] });
      const p1 = makePlayer({ id: "p1", money: 0, properties: [] });
      const state = makeState({ board: [], players: [p0, p1] });

      service.handle(state, p0, null, 50);

      expect(state.status).toBe("finished");
      expect(state.winnerId).toBe("p1");
    });
  });
});
