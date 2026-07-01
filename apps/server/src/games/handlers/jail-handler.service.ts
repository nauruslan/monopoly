import { Injectable } from "@nestjs/common";
import type { Player } from "@monopoly/shared";

/**
 * Обработчик тюремной механики.
 *
 * Правила:
 *  - При попадании на `GOTO_JAIL` или при 3 дублях подряд — `sendToJail`.
 *  - В тюрьме игрок может бросить кости:
 *      * дубль → мгновенный выход, счётчик дублей сбрасывается;
 *      * не дубль → `jailTurns` инкрементируется;
 *      * на 3-й ход (jailTurns >= 3) — вынужден заплатить ₽50 и выйти.
 *  - Дополнительно: `tryDoubleOrPay` возвращает результат броска, чтобы
 *    вызывающий код мог решить, продолжать ли ход или передавать дальше.
 */
@Injectable()
export class JailHandlerService {
  /**
   * Клетка `В тюрьму!` или 3-й дубль подряд.
   * Сбрасывает `consecutiveDoubles` (важно для правила трёх дублей).
   */
  sendToJail(player: Player): void {
    player.position = 10; // позиция клетки JAIL на стандартной доске
    player.inJail = true;
    player.jailTurns = 0;
    player.consecutiveDoubles = 0;
  }

  /**
   * Попытка выйти из тюрьмы броском костей.
   *
   * Возвращает один из трёх исходов:
   *  - `"escape"` — игрок выбросил дубль и сразу вышел;
   *  - `"stay"`   — остаётся в тюрьме ещё на один ход;
   *  - `"pay"`    — третий ход без дубля, принудительно списали ₽50.
   */
  tryDoubleOrPay(player: Player, dice: [number, number]): "escape" | "stay" | "pay" {
    // Дубль — счастливый билет на выход.
    if (dice[0] === dice[1]) {
      player.inJail = false;
      player.jailTurns = 0;
      return "escape";
    }
    // Не дубль — считаем попытки.
    player.jailTurns += 1;
    if (player.jailTurns >= 3) {
      // Принудительная оплата штрафа. `Math.max(0, ...)` — защита от
      // отрицательного баланса; в реальной логике после этого должен
      // сработать `BankruptcyService` (TODO Шаг 27+).
      player.money = Math.max(0, player.money - 50);
      player.inJail = false;
      player.jailTurns = 0;
      return "pay";
    }
    return "stay";
  }
}
