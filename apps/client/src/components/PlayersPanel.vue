<script setup lang="ts">
import { computed } from "vue";
import { storeToRefs } from "pinia";
import type { Player, Cell, Card } from "@monopoly/shared";
import { CHANCE_CARDS, TREASURY_CARDS, countActiveMonopolies } from "@monopoly/shared";
import { useGameStore } from "../stores/game";

/**
 * Справочник `templateId → Card` для быстрого поиска названия/текста
 * holdable-карточки по её `templateId` из `player.holdableCards`.
 * Сейчас единственный holdable-эффект — `jail-free` (`ch7` в колоде Шанс),
 * но в будущем могут появиться и другие — словарь покроет их автоматически.
 */
const CARD_TEMPLATE_BY_ID: Record<string, Card> = (() => {
  const out: Record<string, Card> = {};
  for (const c of CHANCE_CARDS) out[c.id] = c;
  for (const c of TREASURY_CARDS) out[c.id] = c;
  return out;
})();

const props = defineProps<{
  players: Player[];
  currentPlayerId: string;
}>();

const game = useGameStore();
// берём `state` реактивно, чтобы индикатор «Думает…» обновлялся
// при смене `state.botThinking` (сервер рассылает его в `game:state`).
const { state } = storeToRefs(game);

const thinkingPlayerId = computed(() => state.value.botThinking?.playerId ?? null);

/**
 * Доска из стора — источник правды для подсчёта домов/отелей/монополий/активов.
 * Реактивна, т.к. берётся через storeToRefs (см. `state` выше).
 */
const board = computed<Cell[]>(() => state.value.board);

interface PlayerStats {
  /** Сколько ПОЛНЫХ цветовых монополий у игрока. */
  monopolies: number;
  /** Суммарное число домов (houses в диапазоне 1..4). */
  houses: number;
  /** Сколько отелей (houses === 5). */
  hotels: number;
  /** Сколько карточек «выйди из тюрьмы бесплатно» в руке. */
  holdableCount: number;
  /**
   * Сумма ликвидационной стоимости:
   *  - для НЕзаложенной PROPERTY/RAILROAD/UTILITY: `price + houses * (housePrice/2) + hotelBonus`;
   *  - для заложенной — `0` (уже продана банку за mortgageValue — деньги у игрока);
   *  - заложенные клетки в `player.money` уже учтены.
   *
   *  В расчёте также учитываются дома/отели как половина цены покупки.
   *  По правилам Монополии при продаже дома возвращается `housePrice / 2`.
   *  Отель приравнивается к 5 домам, поэтому стоимость 1 отеля = 5 * (housePrice / 2).
   *  Дополнительно: для отеля мы добавляем «сдачу дома обратно» — по нашему
   *  кастомному правилу (`hotelPriceEqualsHousePrice`) при продаже отеля
   *  возвращается 4 * (housePrice / 2) «излишка» (переплата за 5-й дом).
   */
  assets: number;
}

/**
 * Пустой объект статистики (для банкротов, чтобы не сводить computed
 * вручную в шаблоне).
 */
const EMPTY_STATS: PlayerStats = {
  monopolies: 0,
  houses: 0,
  hotels: 0,
  holdableCount: 0,
  assets: 0,
};

/**
 * Карта `playerId → PlayerStats`. Считается ОДИН раз на каждое изменение
 * `board` или `players` (а не на каждого игрока в `v-for`), что заметно
 * дешевле, чем прогонять filter'ы 4 раза для каждого из N игроков.
 */
const statsByPlayer = computed<Record<string, PlayerStats>>(() => {
  const out: Record<string, PlayerStats> = {};

  // Первый проход: инициализируем записи для всех живых игроков,
  // чтобы шаблон всегда мог безопасно обратиться через `statsMap.get(p.id)`.
  for (const p of props.players) {
    out[p.id] = { ...EMPTY_STATS };
  }

  // Группируем клетки по владельцам.
  const ownedByPlayer = new Map<string, Cell[]>();
  for (const cell of board.value) {
    if (!cell.ownerId) continue;
    const list = ownedByPlayer.get(cell.ownerId);
    if (list) list.push(cell);
    else ownedByPlayer.set(cell.ownerId, [cell]);
  }

  // Считаем монополии: используем общий хелпер `countActiveMonopolies`,
  // чтобы UI и сервер использовали ОДНО И ТО ЖЕ определение «активной»
  // монополии: ВСЕ участки группы у владельца И ни один не заложен.
  for (const ownerId of Object.keys(out)) {
    const stats = out[ownerId];
    if (!stats) continue;
    stats.monopolies = countActiveMonopolies(ownerId, board.value);

    // Дальше проходим по клеткам для подсчёта домов/отелей/ликвидационной
    // стоимости. Монополии уже посчитаны выше — здесь их НЕ трогаем.
    const cells = ownedByPlayer.get(ownerId) ?? [];
    for (const cell of cells) {
      // Дома/отели.
      //
      // Правило Монополии: на одной клетке может стоять либо 1..4 дома,
      // либо 1 отель — это взаимоисключающие состояния. На доске
      // `cell.houses` хранит 0..4 для домов и 5 для отеля.
      //
      // На панели игрока мы показываем:
      //  - «Дома» — суммарное число ДОМИКОВ (без отелей). Для клетки
      //    с отелем (`houses === 5`) в счётчик «Дома» идёт 0: отель
      //    считается отдельно. Пример: 6 клеток по 1 дому + 3 отеля =
      //    «Дома: 6, Отели: 3» (а не «Дома: 21, Отели: 3»).
      //  - «Отели» — количество клеток с `houses === 5`.
      if (cell.houses >= 1 && cell.houses <= 4) {
        stats.houses += cell.houses;
      } else if (cell.houses === 5) {
        stats.hotels += 1;
      }

      // Ликвидационная стоимость актива.
      //
      // По правилам Монополии, если игрок «продаёт» всё своё имущество банку,
      // он получает:
      //  - за незаложенный участок: номинальную цену (`price`);
      //  - за заложенный участок: сумму залога (`mortgageValue` = `price / 2`).
      //    Деньги за залог УЖЕ у игрока на руках, но сам участок формально
      //    принадлежит банку — поэтому для подсчёта «суммарных активов»
      //    используем именно `mortgageValue` (ту же сумму, что у игрока в
      //    кармане после залога). При выкупе участка обратно — прибавляем
      //    `mortgageValue` (деньги уходят из `money`, но участок возвращается
      //    в активы).
      //  - за каждый дом: `housePrice / 2` (банк выкупает дом за полцены);
      //  - за отель: `5 * (housePrice / 2)` (5 домов по полцены).
      //    Никакой «сдачи» за переплату (4 * half) не прибавляем — в UI
      //    «Активы» показывает, сколько игрок РЕАЛЬНО получит при ликвидации.
      //
      // Дома/отели продаются только на НЕзаложенной клетке (правило), так
      // что для заложенной клетки стоимость построек не прибавляем.
      let cellValue = 0;
      if (cell.isMortgaged) {
        if (cell.mortgageValue) cellValue += cell.mortgageValue;
      } else {
        if (cell.price) cellValue += cell.price;
        if (cell.housePrice) {
          const halfHouse = cell.housePrice / 2;
          if (cell.houses >= 1 && cell.houses <= 4) {
            cellValue += cell.houses * halfHouse;
          } else if (cell.houses === 5) {
            cellValue += 5 * halfHouse;
          }
        }
      }

      stats.assets += cellValue;
    }
  }

  // Holdable-карточки: считаем по `player.holdableCards`.
  for (const p of props.players) {
    const stats = out[p.id];
    if (!stats) continue;
    stats.holdableCount = p.holdableCards ? Object.keys(p.holdableCards).length : 0;
  }

  return out;
});

/**
 * Удобный геттер: статистика по конкретному игроку. Возвращает «нулевую»
 * запись для неизвестного id (защита от реконнекта / рассинхрона).
 */
function statsFor(p: Player): PlayerStats {
  return statsByPlayer.value[p.id] ?? EMPTY_STATS;
}

/**
 * Список «иконок карточек в руке» для отображения в строке `Карточки`.
 *
 * Сейчас единственный holdable-тип — «Выйдите из тюрьмы бесплатно»
 * (`jail-free`, `ch7`). Когда в будущем добавим другие карты в руку,
 * достаточно расширить функцию соответствующим `templateId` → icon/tooltip.
 */
interface CardIcon {
  /** Уникальный ключ для v-for (cardId из holdableCards). */
  key: string;
  /** Иконка для UI. */
  icon: string;
  /** Текст тултипа (название карточки из справочника). */
  title: string;
}

/**
 * Резолвим визуальное представление карточки по её `templateId`:
 * иконку и название из `cards.ts`. На неизвестные шаблоны — дефолт.
 */
function resolveCardIcon(templateId: string): { icon: string; title: string } {
  const tpl = CARD_TEMPLATE_BY_ID[templateId];
  if (tpl) {
    return { icon: "⛓️", title: tpl.text };
  }
  return { icon: "⛓️", title: `Карточка (${templateId})` };
}

function cardIconsFor(p: Player): CardIcon[] {
  const cards = p.holdableCards;
  if (!cards) return [];
  const out: CardIcon[] = [];
  for (const [cardId, entry] of Object.entries(cards)) {
    const { icon, title } = resolveCardIcon(entry.templateId);
    out.push({ key: cardId, icon, title });
  }
  return out;
}

/**
 * Форматирование денег/активов в компактный вид: 1 200 000 → «1.2M».
 * Для значений < 100_000 показывает полное число с разделителями.
 */
function formatAssets(value: number): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M₽`;
  }
  if (value >= 10_000) {
    return `${Math.round(value / 1_000)}K₽`;
  }
  return `${value}₽`;
}
</script>

<template>
  <div class="players-wrap">
    <div class="players-grid">
      <div
        v-for="p in players"
        :key="p.id"
        class="player-card"
        :class="{
          active: p.id === currentPlayerId && !p.isBankrupt,
          thinking: p.id === thinkingPlayerId,
          bankrupt: p.isBankrupt,
        }"
        :style="{ '--player-color': p.color }"
      >
        <div class="player-header">
          <div class="player-avatar" :style="{ background: p.color }">
            {{ p.icon }}
          </div>
          <div class="player-name">
            {{ p.displayName }}
            <span v-if="p.inJail" class="jail-badge">🔒</span>
            <span v-if="p.kind === 'bot'" class="bot-badge">🤖</span>
            <span v-if="p.isBankrupt" class="bankrupt-badge" title="Игрок обанкротился и выбыл">
              💀 БАНКРОТ
            </span>
          </div>
        </div>
        <div class="player-money">₽{{ p.money.toLocaleString() }}</div>

        <div v-if="!p.isBankrupt" class="player-stats">
          <div class="stat-row" :title="`Собственность: ${p.properties.length} клеток`">
            <span class="stat-label">Собственность</span>
            <span class="stat-value">{{ p.properties.length }}</span>
          </div>
          <div class="stat-row" :title="`Полных монополий: ${statsFor(p).monopolies}`">
            <span class="stat-label">Монополии</span>
            <span class="stat-value">{{ statsFor(p).monopolies }}</span>
          </div>
          <div class="stat-row" :title="`Домов: ${statsFor(p).houses}`">
            <span class="stat-label">Дома</span>
            <span class="stat-value">{{ statsFor(p).houses }}</span>
          </div>
          <div class="stat-row" :title="`Отелей: ${statsFor(p).hotels}`">
            <span class="stat-label">Отели</span>
            <span class="stat-value">{{ statsFor(p).hotels }}</span>
          </div>
          <div class="stat-row" :title="`Карточек в руке: ${statsFor(p).holdableCount}`">
            <span class="stat-label">Карточки</span>
            <span class="stat-value stat-value-cards">
              <span
                v-for="c in cardIconsFor(p)"
                :key="c.key"
                class="holdable-mini"
                :title="c.title"
                >{{ c.icon }}</span
              >
            </span>
          </div>
          <div
            class="stat-row stat-row-assets"
            :title="`Активы: ₽${statsFor(p).assets.toLocaleString()}`"
          >
            <span class="stat-label">Активы</span>
            <span class="stat-value">{{ formatAssets(statsFor(p).assets) }}</span>
          </div>
        </div>
        <div v-else class="player-props">Выбыл из игры</div>

        <!-- индикатор «Думает…» для бота в фазе BOT_THINKING. -->
        <div
          v-if="p.id === thinkingPlayerId && !p.isBankrupt"
          class="thinking-indicator"
          aria-live="polite"
        >
          <span class="thinking-dots"> <span>.</span><span>.</span><span>.</span> </span>
          <span class="thinking-text">Думает</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.players-wrap {
  background: transparent;
  border: none;
  padding: 0;
  height: 100%;
  width: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
}
.jail-badge,
.bot-badge,
.bankrupt-badge {
  font-size: 11px;
  margin-left: 4px;
  opacity: 0.8;
}
.bankrupt-badge {
  display: inline-block;
  background: linear-gradient(135deg, #c33, #ff5e5e);
  color: #fff;
  padding: 1px 6px;
  border-radius: 6px;
  font-size: 10px;
  font-weight: 800;
  letter-spacing: 0.5px;
  margin-left: 6px;
  opacity: 1;
  box-shadow: 0 1px 4px rgba(204, 51, 51, 0.4);
}
.player-card.bankrupt {
  filter: grayscale(0.85) brightness(0.75);
  opacity: 0.75;
  position: relative;
}
.player-card.bankrupt::after {
  content: "";
  position: absolute;
  inset: 0;
  border: 2px dashed rgba(204, 51, 51, 0.55);
  border-radius: inherit;
  pointer-events: none;
}
.player-card.bankrupt .player-money {
  color: #c33;
  text-decoration: line-through;
}
/* подсветка карточки + анимированный индикатор «Думает…». */
.player-card.thinking {
  outline: 2px solid #9b6dff;
  outline-offset: 2px;
  animation: card-pulse 1.2s ease-in-out infinite;
}

.player-stats {
  margin-top: 8px;
  padding-top: 6px;
  border-top: 1px solid rgba(255, 255, 255, 0.06);
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.stat-row {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 10.5px;
  color: var(--text2);
  line-height: 1.35;
}
.stat-row .stat-label {
  flex: 1;
  letter-spacing: 0.2px;
}
.stat-row .stat-value {
  font-family: "Space Grotesk", monospace;
  font-weight: 700;
  color: var(--text);
  font-size: 11px;
  min-width: 28px;
  text-align: right;
  text-shadow: 0 0 6px rgba(194, 178, 235, 0.18);
  display: inline-flex;
  align-items: center;
  justify-content: flex-end;
  gap: 2px;
}
.stat-row-assets {
  margin-top: 4px;
  padding-top: 5px;
  border-top: 1px dashed rgba(149, 114, 218, 0.18);
}
.stat-row-assets .stat-value {
  color: var(--gold);
  text-shadow: 0 0 8px rgba(194, 178, 235, 0.35);
}
.stat-value-cards {
  min-width: 0;
  gap: 3px;
  justify-content: flex-end;
}
.holdable-mini {
  font-size: 12px;
  line-height: 1;
  filter: drop-shadow(0 0 4px rgba(149, 114, 218, 0.5));
  cursor: help;
  transition: transform 0.15s var(--ease-out);
}
.holdable-mini:hover {
  transform: scale(1.25);
  filter: drop-shadow(0 0 6px rgba(194, 178, 235, 0.8));
}
.thinking-indicator {
  margin-top: 8px;
  padding: 4px 8px;
  background: rgba(155, 109, 255, 0.18);
  border: 1px solid rgba(155, 109, 255, 0.5);
  border-radius: 6px;
  font-size: 12px;
  display: flex;
  align-items: center;
  gap: 4px;
  color: #d6c6ff;
}
.thinking-dots {
  display: inline-flex;
  gap: 1px;
}
.thinking-dots span {
  animation: dot-blink 1.2s infinite;
  font-weight: bold;
}
.thinking-dots span:nth-child(2) {
  animation-delay: 0.2s;
}
.thinking-dots span:nth-child(3) {
  animation-delay: 0.4s;
}
.thinking-text {
  margin-left: 4px;
}
@keyframes dot-blink {
  0%,
  60%,
  100% {
    opacity: 0.2;
  }
  30% {
    opacity: 1;
  }
}
@keyframes card-pulse {
  0%,
  100% {
    box-shadow: 0 0 0 0 rgba(155, 109, 255, 0.4);
  }
  50% {
    box-shadow: 0 0 0 6px rgba(155, 109, 255, 0);
  }
}
</style>
