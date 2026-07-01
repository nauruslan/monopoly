import { Injectable } from "@nestjs/common";
import { CHANCE_CARDS, TREASURY_CARDS, type Card } from "@monopoly/shared";
import type { Player, GameState } from "@monopoly/shared";

/**
 * Обработчик карточек Шанс / Общественная казна.
 *
 * На вход получает тип колоды, текущего игрока и state.
 * Возвращает вытянутую карточку (для отображения на клиенте).
 *
 * Логика максимально близка к клиентскому `applyCardEffect` из
 * `apps/client/src/stores/game.ts`, но без зависимости от Vue/Pinia.
 *
 * TODO (Шаг 28+): использовать детерминированный RNG на основе `state.seed`
 * и `state.rngCursor`, чтобы реплеи были воспроизводимыми.
 */
@Injectable()
export class CardHandlerService {
  /**
   * Вытянуть случайную карточку из нужной колоды и применить её эффект
   * к игроку (мутация по ссылке, как принято в этой кодовой базе).
   */
  draw(deck: "chance" | "treasury", player: Player, state: GameState): Card {
    const cards = deck === "chance" ? CHANCE_CARDS : TREASURY_CARDS;
    // Math.random() — пока допустимо; заменим на seeded RNG в Шаге 28.
    const card = cards[Math.floor(Math.random() * cards.length)]!;

    switch (card.effect.kind) {
      case "money":
        // Положительная или отрицательная сумма (`amount` уже со знаком).
        player.money += card.effect.amount;
        break;

      case "move":
        // Телепорт на конкретную клетку. Если есть `money` (бонус за
        // прохождение GO) — начисляем (например, ch1: "Вперёд + ₽200").
        player.position = card.effect.target;
        if (card.effect.money !== undefined) {
          player.money += card.effect.money;
        }
        break;

      case "move-relative":
        // Сдвиг на N клеток (вперёд/назад) с оборачиванием по 40.
        player.position = (player.position + card.effect.steps + 40) % 40;
        break;

      case "goto-jail":
        // Прямой переход в тюрьму (минуя клетку GOTO_JAIL на доске).
        player.position = 10;
        player.inJail = true;
        player.jailTurns = 0;
        player.consecutiveDoubles = 0;
        break;

      case "jail-free":
        // Выдаём карточку "выйди из тюрьмы бесплатно".
        player.jailCards += 1;
        break;
    }

    // Поле `state` оставлено в сигнатуре намеренно — здесь могут быть
    // эффекты, меняющие глобальное состояние (например, "все игроки платят
    // тебе ₽50"). Пока таких карточек нет, но точка расширения уже есть.
    void state;

    return card;
  }
}
