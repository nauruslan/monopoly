import { Injectable } from "@nestjs/common";
import type { GameState, Player } from "@monopoly/shared";

/**
 * BankService — единственная точка входа для финансовых транзакций в партии.
 *
 * ## Зачем нужен Bank-объект
 *
 * Все денежные операции (оплата ренты, штрафов, покупка,
 * начисление зарплаты при прохождении СТАРТА, выплата залога/продажи
 * недвижимости) должны проходить через единый шлюз — объект `Bank`.
 * Никаких прямых `player.money -= 50; player2.money += 50`".
 *
 * Это решает несколько задач:
 *  1. **Атомарность**: внутри `transfer` можно в любой момент добавить
 *     логирование, событие `MoneyTransferred` для клиента, проверки
 *     на отрицательный баланс (для триггера банкротства).
 *  2. **Единая семантика**: "кредитор" (куда уходят деньги) может
 *     быть null = Банк (налог, штраф), или Player (рента другому игроку).
 *  3. **Тестируемость**: в тестах можно подменить/проверить все
 *     денежные потоки через один интерфейс.
 *
 * ## Контракт
 *
 *  - Метод `transfer(state, from, to, amount, reason)`:
 *      - списывает `amount` с `from` (если from != null) — `from.money -= amount`;
 *      - зачисляет `amount` на `to` (если to != null) — `to.money += amount`;
 *      - возвращает фактически списанную/полученную сумму (с учётом
 *        возможного "обнуления" в случае банкротства — см. clampToZero).
 *  - Метод `credit(player, amount, reason)` — просто зачислить
 *    (продажа дома, выручка от залога, прохождение СТАРТА).
 *  - Метод `debit(player, amount, reason)` — просто списать
 *    (покупка клетки, оплата штрафа).
 *  - Метод `clampToZero(player)` — обнулить отрицательный остаток
 *    (используется в момент объявления банкротства).
 *
 * ВАЖНО: этот сервис НЕ принимает решение о банкротстве. Если после
 * `debit` баланс ушёл в минус, вызывающий код сам решает, вызывать
 * ли `GamesService.shouldStartBankruptcy`. Bank лишь гарантирует
 * корректную арифметику.
 */
@Injectable()
export class BankService {
  /**
   * Списать `amount` с `player`. Если `player.money - amount < 0` —
   * возвращаемое значение покажет, сколько реально списано (с
   * отрицательным итогом — игрок ушёл в минус).
   *
   * @returns новое значение `player.money`
   */
  debit(player: Player, amount: number, _reason?: string): number {
    if (amount < 0) {
      throw new Error(`BankService.debit: amount must be >= 0, got ${amount}`);
    }
    player.money -= amount;
    return player.money;
  }

  /**
   * Зачислить `amount` на `player`. Никогда не уходит в минус.
   *
   * @returns новое значение `player.money`
   */
  credit(player: Player, amount: number, _reason?: string): number {
    if (amount < 0) {
      throw new Error(`BankService.credit: amount must be >= 0, got ${amount}`);
    }
    player.money += amount;
    return player.money;
  }

  /**
   * Перевести `amount` от `from` к `to`.
   *
   * @param from    отправитель (Player). Если null — деньги "из Банка" (налог, штраф в казну).
   * @param to      получатель  (Player). Если null — деньги "в Банк" (оплата налога/штрафа).
   * @param amount  сумма перевода (>= 0)
   * @param reason  семантическая метка для логов/событий (опционально)
   *
   * Поведение:
   *  - Если `from` не задан — это перевод "из Банка" (например, зарплата
   *    при прохождении СТАРТА, `to` обязателен).
   *  - Если `to` не задан — это перевод "в Банк" (оплата налога/штрафа,
   *    `from` обязателен).
   *  - Если оба заданы — перевод между игроками (рента/торговля).
   *  - Если оба null — no-op (логически бессмысленно).
   *
   * @returns объект `{ fromBalance, toBalance }` с новыми балансами.
   */
  transfer(
    _state: GameState,
    from: Player | null,
    to: Player | null,
    amount: number,
    _reason?: string,
  ): { fromBalance: number; toBalance: number } {
    if (amount < 0) {
      throw new Error(`BankService.transfer: amount must be >= 0, got ${amount}`);
    }
    if (!from && !to) {
      return { fromBalance: 0, toBalance: 0 };
    }

    if (from) {
      from.money -= amount;
    }
    if (to) {
      to.money += amount;
    }
    return {
      fromBalance: from?.money ?? 0,
      toBalance: to?.money ?? 0,
    };
  }

  /**
   * Обнулить баланс игрока (используется при объявлении банкротства).
   * Возвращает "сгоревшую" сумму (>= 0).
   */
  clampToZero(player: Player): number {
    if (player.money >= 0) return 0;
    const burned = -player.money;
    player.money = 0;
    return burned;
  }
}
