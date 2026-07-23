<script setup lang="ts">
/**
 * TradeModal — трёхэкранная модалка обмена + экран уведомления.
 *
 * Экраны:
 *  1. select-partner — выбор партнёра для обмена (если мы инициируем)
 *  2. compose        — двухсторонняя панель обмена (мои активы слева, его — справа)
 *  3. result         — уведомление о завершении сделки (принята/отклонена/отменена).
 *                      Закрывается ТОЛЬКО кнопкой «Принять» в нижней части окна.
 *
 * Также показывает активный обмен с сервера (TRADING_NEGOTIATE / TRADING_CONFIRM).
 *
 * Управление через useTradeStore (локальный state + server-of-truth в state.trade).
 */
import { computed, watch } from "vue";
import Modal from "../Modal.vue";
import { useTradeStore } from "../../stores/trade";
import { useGameStore } from "../../stores/game";
import type { Cell, Player } from "@monopoly/shared";

const trade = useTradeStore();
const game = useGameStore();

const show = computed<boolean>(() => {
  // result-экран должен показываться даже если других признаков открытой
  // модалки нет. Пока lastResult !== null — модалка видна.
  if (trade.lastResult !== null) return true;
  if (trade.inActiveTrade) return true; // активная торговля
  return trade.screen !== "closed";
});

// При появлении нового активного trade — закрываем локальный экран compose/waiting
watch(
  () => trade.trade,
  (t) => {
    if (t && !trade.lastResult) {
      trade.screen = "closed";
      trade.lastError = null;
    }
  },
);

// При начале TRADING_NEGOTIATE — мы НЕ должны показывать локальный draft.
// При TRADING_CONFIRM — мы на экране подтверждения.

const state = computed(() => game.state);

// Текущий игрок и партнёр
const myPlayer = computed<Player | null>(() => trade.me);
const recipient = computed<Player | null>(() => {
  // При активной торговле — берём из state.trade
  if (trade.trade) {
    const id =
      trade.trade.initiatorId === trade.myId ? trade.trade.recipientId : trade.trade.initiatorId;
    return state.value?.players.find((p) => p.id === id) ?? null;
  }
  return trade.recipient;
});

const isInitiator = computed(() => {
  if (trade.trade) return trade.trade.initiatorId === trade.myId;
  return true; // в draft-режиме инициатор — тот, кто составил
});

const isOnClock = computed(() => trade.isOnClock);
const isConfirmPhase = computed(() => trade.isConfirmPhase);
const isResultScreen = computed(() => trade.isResultScreen);

// Активный оффер с сервера
const activeOffer = computed(() => trade.trade?.offer ?? null);

const counterCount = computed(() => trade.trade?.counterCount ?? 0);
const maxCounter = computed(() => state.value?.settings.tradingMaxCounterOffers ?? 3);

const canCounter = computed(() => counterCount.value < maxCounter.value);

// Свойства (для экрана compose)
const myTradableProperties = computed<Cell[]>(() => trade.myTradableProperties);
const recipientProperties = computed<Cell[]>(() => {
  if (!recipient.value || !state.value) return [];
  return state.value.board.filter((c) => c.ownerId === recipient.value!.id);
});

// Помощники: номинальная стоимость, цвет и пр. для UI.
function getCell(id: number) {
  return state.value?.board[id] ?? null;
}
const cellName = (id: number): string => getCell(id)?.name ?? `#${id}`;
const cellColor = (id: number): string => getCell(id)?.color ?? "#888";
const isMortgaged = (id: number): boolean => getCell(id)?.isMortgaged === true;
// Номинальная стоимость клетки (цена покупки у банка). Для клеток без цены — null.
const cellPrice = (id: number): number | null => {
  const c = getCell(id);
  return c && typeof c.price === "number" ? c.price : null;
};
const cellRent = (id: number): number | null => {
  const c = getCell(id);
  return c && typeof c.rent === "number" ? c.rent : null;
};
// Формат цены с разделителями разрядов (₽1 200).
const fmt = (n: number): string => n.toLocaleString("ru-RU");

// Я заблокирован партнёром?
const blockedByPartner = computed<boolean>(() => trade.isBlockedByPartner);
const iBlocked = computed<boolean>(() => trade.iBlockedPartner);

const recipientJailCards = computed<number>(() => recipient.value?.jailCards ?? 0);
const myJailCards = computed<number>(() => trade.me?.jailCards ?? 0);
const myMoney = computed<number>(() => trade.me?.money ?? 0);

function onClose() {
  // На экране уведомления о результате закрытие иначе как через «Принять» запрещено.
  if (isResultScreen.value) return;
  if (trade.inActiveTrade) return; // нельзя закрыть активную торговлю
  trade.close();
}

function onSelectPartner(id: string) {
  trade.selectPartner(id);
}

function onBack() {
  trade.backToPartnerSelection();
}

function onPropose() {
  trade.proposeOffer();
}

function onAccept() {
  trade.accept();
}

function onReject() {
  trade.reject();
}

function onCancel() {
  trade.cancel();
}

function onCounter() {
  if (!activeOffer.value) return;
  // Загрузить текущий оффер в draft (с инверсией сторон, т.к. меняемся ролями)
  const t = trade.trade;
  if (!t) return;
  // draft.fromX — это то, что Я отдаю; toX — то, что Я прошу
  // Если я был recipient, то я отдаю toX, прошу fromX
  // Если я был initiator, то я отдаю fromX, прошу toX (counter не меняет роли в нашей логике)
  const draft = {
    fromProperties: isInitiator.value
      ? [...activeOffer.value.fromProperties]
      : [...activeOffer.value.toProperties],
    fromCash: isInitiator.value ? activeOffer.value.fromCash : activeOffer.value.toCash,
    fromJailCards: isInitiator.value
      ? activeOffer.value.fromJailCards
      : activeOffer.value.toJailCards,
    toProperties: isInitiator.value
      ? [...activeOffer.value.toProperties]
      : [...activeOffer.value.fromProperties],
    toCash: isInitiator.value ? activeOffer.value.toCash : activeOffer.value.fromCash,
    toJailCards: isInitiator.value
      ? activeOffer.value.toJailCards
      : activeOffer.value.fromJailCards,
  };
  trade.draft = draft;
  trade.selectedRecipientId = recipient.value?.id ?? null;
  trade.screen = "compose";
  trade.setError(null);
}

function onSubmitCounter() {
  trade.counter();
}

function onToggleBlock(id: string) {
  trade.toggleBlock(id);
}

function onAcknowledgeResult() {
  // Закрывает экран уведомления и выходит из режима торговли
  trade.acknowledgeResult();
}

const modalTitle = computed<string>(() => {
  if (isResultScreen.value) {
    return trade.lastResult?.title ?? "🤝 Сделка завершена";
  }
  if (trade.inActiveTrade) {
    return trade.isConfirmPhase ? "✅ Подтверждение обмена" : "🤝 Обмен";
  }
  if (trade.screen === "select-partner") return "🤝 Выберите партнёра";
  if (trade.screen === "compose") return "🤝 Составление предложения";
  return "🤝 Обмен";
});

const modalSubtitle = computed<string>(() => {
  if (isResultScreen.value) {
    return trade.lastResult?.partnerName ? `Партнёр: ${trade.lastResult.partnerName}` : "";
  }
  if (trade.inActiveTrade) {
    const init = trade.trade
      ? state.value?.players.find((p) => p.id === trade.trade!.initiatorId)
      : null;
    const rec = trade.trade
      ? state.value?.players.find((p) => p.id === trade.trade!.recipientId)
      : null;
    return init && rec ? `${init.displayName} \u2194 ${rec.displayName}` : "";
  }
  return "";
});
</script>

<template>
  <Modal
    :show="show"
    :title="modalTitle"
    :subtitle="modalSubtitle"
    :closable="!isResultScreen"
    @close="onClose"
  >
    <!-- Активный обмен с сервера -->
    <div v-if="trade.inActiveTrade && activeOffer" class="trade-card">
      <!-- Баннер текущей фазы -->
      <div v-if="isConfirmPhase" class="phase-banner confirm">
        ⏳ Инициатор должен подтвердить изменённые условия.
      </div>
      <div v-else-if="isOnClock" class="phase-banner your-turn">
        🎯 Сейчас ваш ход — примите, отклоните или предложите встречное.
      </div>
      <div v-else class="phase-banner wait">⏸ Ожидаем ответа второй стороны.</div>

      <!-- Сводка оффера -->
      <div class="trade-sides">
        <div class="trade-side">
          <div class="side-title">
            <span class="icon" :style="{ color: myPlayer?.color }">●</span>
            <span>{{ myPlayer?.displayName }} (вы)</span>
          </div>
          <div class="side-section">
            <div class="section-label">Отдаёте</div>
            <div
              v-if="
                (isInitiator ? activeOffer.fromProperties : activeOffer.toProperties).length ===
                  0 &&
                (isInitiator ? activeOffer.fromCash : activeOffer.toCash) === 0 &&
                (isInitiator ? activeOffer.fromJailCards : activeOffer.toJailCards) === 0
              "
              class="empty"
            >
              ничего
            </div>
            <div v-else class="items">
              <div
                v-for="pid in isInitiator ? activeOffer.fromProperties : activeOffer.toProperties"
                :key="`give-prop-${pid}`"
                class="item"
                :style="{ borderColor: cellColor(pid) }"
              >
                <span class="cell-color" :style="{ background: cellColor(pid) }"></span>
                <span class="item-name">{{ cellName(pid) }}</span>
                <span
                  v-if="cellPrice(pid) !== null"
                  class="item-price"
                  :title="`Рента базовая: ${cellRent(pid) ?? 0}₽`"
                >
                  {{ fmt(cellPrice(pid)!) }}₽
                </span>
                <span v-if="isMortgaged(pid)" class="badge-mortgaged">заложена</span>
              </div>
              <div
                v-if="(isInitiator ? activeOffer.fromCash : activeOffer.toCash) > 0"
                class="item cash"
              >
                ₽{{ isInitiator ? activeOffer.fromCash : activeOffer.toCash }}
              </div>
              <div
                v-if="(isInitiator ? activeOffer.fromJailCards : activeOffer.toJailCards) > 0"
                class="item jail"
              >
                🎫 ×{{ isInitiator ? activeOffer.fromJailCards : activeOffer.toJailCards }}
              </div>
            </div>
          </div>
          <div class="side-section">
            <div class="section-label">Получаете</div>
            <div
              v-if="
                (isInitiator ? activeOffer.toProperties : activeOffer.fromProperties).length ===
                  0 &&
                (isInitiator ? activeOffer.toCash : activeOffer.fromCash) === 0 &&
                (isInitiator ? activeOffer.toJailCards : activeOffer.fromJailCards) === 0
              "
              class="empty"
            >
              ничего
            </div>
            <div v-else class="items">
              <div
                v-for="pid in isInitiator ? activeOffer.toProperties : activeOffer.fromProperties"
                :key="`recv-prop-${pid}`"
                class="item"
                :style="{ borderColor: cellColor(pid) }"
              >
                <span class="cell-color" :style="{ background: cellColor(pid) }"></span>
                <span class="item-name">{{ cellName(pid) }}</span>
                <span
                  v-if="cellPrice(pid) !== null"
                  class="item-price"
                  :title="`Рента базовая: ${cellRent(pid) ?? 0}₽`"
                >
                  {{ fmt(cellPrice(pid)!) }}₽
                </span>
                <span v-if="isMortgaged(pid)" class="badge-mortgaged">заложена</span>
              </div>
              <div
                v-if="(isInitiator ? activeOffer.toCash : activeOffer.fromCash) > 0"
                class="item cash"
              >
                ₽{{ isInitiator ? activeOffer.toCash : activeOffer.fromCash }}
              </div>
              <div
                v-if="(isInitiator ? activeOffer.toJailCards : activeOffer.fromJailCards) > 0"
                class="item jail"
              >
                🎫 ×{{ isInitiator ? activeOffer.toJailCards : activeOffer.fromJailCards }}
              </div>
            </div>
          </div>
        </div>

        <div class="trade-arrow">⇄</div>

        <div class="trade-side">
          <div class="side-title">
            <span class="icon" :style="{ color: recipient?.color }">●</span>
            <span>{{ recipient?.displayName }}</span>
          </div>
          <div class="side-section">
            <div class="section-label">Отдаёт</div>
            <div
              v-if="
                (isInitiator ? activeOffer.toProperties : activeOffer.fromProperties).length ===
                  0 &&
                (isInitiator ? activeOffer.toCash : activeOffer.fromCash) === 0 &&
                (isInitiator ? activeOffer.toJailCards : activeOffer.fromJailCards) === 0
              "
              class="empty"
            >
              ничего
            </div>
            <div v-else class="items">
              <div
                v-for="pid in isInitiator ? activeOffer.toProperties : activeOffer.fromProperties"
                :key="`opp-give-prop-${pid}`"
                class="item"
                :style="{ borderColor: cellColor(pid) }"
              >
                <span class="cell-color" :style="{ background: cellColor(pid) }"></span>
                <span class="item-name">{{ cellName(pid) }}</span>
                <span
                  v-if="cellPrice(pid) !== null"
                  class="item-price"
                  :title="`Рента базовая: ${cellRent(pid) ?? 0}₽`"
                >
                  {{ fmt(cellPrice(pid)!) }}₽
                </span>
                <span v-if="isMortgaged(pid)" class="badge-mortgaged">заложена</span>
              </div>
              <div
                v-if="(isInitiator ? activeOffer.toCash : activeOffer.fromCash) > 0"
                class="item cash"
              >
                ₽{{ isInitiator ? activeOffer.toCash : activeOffer.fromCash }}
              </div>
              <div
                v-if="(isInitiator ? activeOffer.toJailCards : activeOffer.fromJailCards) > 0"
                class="item jail"
              >
                🎫 ×{{ isInitiator ? activeOffer.toJailCards : activeOffer.fromJailCards }}
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="trade-meta">
        <small>Встречных предложений: {{ counterCount }}/{{ maxCounter }}</small>
      </div>

      <div class="trade-actions">
        <template v-if="!isConfirmPhase">
          <button class="action-btn btn-accept" :disabled="!isOnClock" @click="onAccept">
            ✅ Принять
          </button>
          <button
            class="action-btn btn-counter"
            :disabled="!isOnClock || !canCounter"
            @click="onCounter"
          >
            ↩️ Встречное ({{ counterCount }}/{{ maxCounter }})
          </button>
          <button class="action-btn btn-reject" :disabled="!isOnClock" @click="onReject">
            ❌ Отклонить
          </button>
          <button
            v-if="isInitiator"
            class="action-btn btn-cancel"
            :disabled="isOnClock"
            @click="onCancel"
          >
            Отменить
          </button>
        </template>
        <template v-else>
          <button class="action-btn btn-accept" :disabled="!isOnClock" @click="onAccept">
            ✅ Подтвердить
          </button>
          <button class="action-btn btn-reject" :disabled="!isOnClock" @click="onReject">
            ❌ Отклонить
          </button>
        </template>
      </div>
    </div>

    <!-- Экран 1: выбор партнёра -->
    <div
      v-else-if="!trade.inActiveTrade && trade.screen === 'select-partner'"
      class="partner-picker"
    >
      <div class="picker-hint">Выберите игрока для обмена:</div>
      <div class="partner-list">
        <div
          v-for="p in trade.partners"
          :key="p.id"
          class="partner-card"
          :class="{ blocked: p.blockedPlayers?.includes(trade.myId ?? '') }"
          @click="onSelectPartner(p.id)"
        >
          <span class="partner-icon" :style="{ color: p.color }">●</span>
          <div class="partner-info">
            <div class="partner-name">{{ p.displayName }}</div>
            <div class="partner-meta">
              {{ p.money }}₽ · {{ p.properties.length }} клеток
              <span v-if="p.jailCards > 0"> · 🎫 ×{{ p.jailCards }}</span>
            </div>
            <div v-if="p.blockedPlayers?.includes(trade.myId ?? '')" class="blocked-note">
              ⛔ Заблокировал вас
            </div>
          </div>
          <button
            v-if="trade.me && p.id !== trade.myId"
            class="block-toggle"
            :title="
              (trade.me.blockedPlayers ?? []).includes(p.id) ? 'Разблокировать' : 'Заблокировать'
            "
            @click.stop="onToggleBlock(p.id)"
          >
            {{ (trade.me.blockedPlayers ?? []).includes(p.id) ? "🚫" : "✅" }}
          </button>
        </div>
      </div>
    </div>

    <!-- Экран 2: двухсторонний compose  -->
    <div
      v-else-if="!trade.inActiveTrade && trade.screen === 'compose' && recipient"
      class="compose-card"
    >
      <div class="compose-header">
        <button class="back-btn" @click="onBack">← К выбору партнёра</button>
        <div class="compose-title">
          <span class="icon" :style="{ color: myPlayer?.color }">●</span>
          <span>{{ myPlayer?.displayName }}</span>
          <span class="arrow">⇄</span>
          <span class="icon" :style="{ color: recipient.color }">●</span>
          <span>{{ recipient.displayName }}</span>
        </div>
      </div>

      <div v-if="blockedByPartner" class="error-banner">
        ⛔ Этот игрок заблокировал вас. Обмен невозможен.
      </div>
      <div v-else-if="iBlocked" class="warn-banner">
        ⚠️ Вы заблокировали этого игрока. Разблокируйте, чтобы торговать.
      </div>

      <div class="compose-sides">
        <!-- ЛЕВАЯ СТОРОНА: я отдаю -->
        <div class="compose-side">
          <div class="side-title">
            <span class="icon" :style="{ color: myPlayer?.color }">●</span>
            Вы отдаёте
          </div>

          <div class="cash-row">
            <label>Наличные:</label>
            <input
              type="number"
              min="0"
              :max="myMoney"
              :value="trade.draft.fromCash"
              @input="(e) => trade.setFromCash(Number((e.target as HTMLInputElement).value))"
            />
            <span class="cash-hint">/ {{ myMoney }}₽</span>
          </div>

          <div v-if="myJailCards > 0" class="cash-row">
            <label>Карточки тюрьмы:</label>
            <input
              type="number"
              min="0"
              :max="myJailCards"
              :value="trade.draft.fromJailCards"
              @input="
                (e) =>
                  (trade.draft.fromJailCards = Math.min(
                    myJailCards,
                    Math.max(0, Number((e.target as HTMLInputElement).value)),
                  ))
              "
            />
            <span class="cash-hint">/ {{ myJailCards }}</span>
          </div>

          <div class="section-label">Свойства (без зданий):</div>
          <div v-if="myTradableProperties.length === 0" class="empty">нет доступных для обмена</div>
          <div v-else class="property-grid">
            <button
              v-for="cell in myTradableProperties"
              :key="cell.id"
              class="property-card"
              :class="{ selected: trade.draft.fromProperties.includes(cell.id) }"
              :style="{ borderColor: cellColor(cell.id) }"
              @click="trade.toggleMyProperty(cell.id)"
            >
              <span class="cell-color" :style="{ background: cellColor(cell.id) }"></span>
              <span class="property-name">{{ cellName(cell.id) }}</span>
              <span
                v-if="cellPrice(cell.id) !== null"
                class="property-price"
                :title="`Рента базовая: ${cellRent(cell.id) ?? 0}₽`"
                >{{ fmt(cellPrice(cell.id)!) }}₽</span
              >
              <span v-if="isMortgaged(cell.id)" class="badge-mortgaged">заложена</span>
            </button>
          </div>
        </div>

        <!-- ПРАВАЯ СТОРОНА: я прошу -->
        <div class="compose-side">
          <div class="side-title">
            <span class="icon" :style="{ color: recipient.color }">●</span>
            Вы просите
          </div>

          <div class="cash-row">
            <label>Наличные:</label>
            <input
              type="number"
              min="0"
              :value="trade.draft.toCash"
              @input="(e) => trade.setToCash(Number((e.target as HTMLInputElement).value))"
            />
            <span class="cash-hint">/ {{ recipient.money }}₽ у него</span>
          </div>

          <div v-if="recipientJailCards > 0" class="cash-row">
            <label>Карточки тюрьмы:</label>
            <input
              type="number"
              min="0"
              :max="recipientJailCards"
              :value="trade.draft.toJailCards"
              @input="
                (e) =>
                  (trade.draft.toJailCards = Math.min(
                    recipientJailCards,
                    Math.max(0, Number((e.target as HTMLInputElement).value)),
                  ))
              "
            />
            <span class="cash-hint">/ {{ recipientJailCards }}</span>
          </div>

          <div class="section-label">Свойства:</div>
          <div v-if="recipientProperties.length === 0" class="empty">нет у партнёра</div>
          <div v-else class="property-grid">
            <button
              v-for="cell in recipientProperties"
              :key="cell.id"
              class="property-card"
              :class="{ selected: trade.draft.toProperties.includes(cell.id) }"
              :style="{ borderColor: cellColor(cell.id) }"
              :disabled="cell.houses > 0"
              @click="trade.toggleRecipientProperty(cell.id)"
            >
              <span class="cell-color" :style="{ background: cellColor(cell.id) }"></span>
              <span class="property-name">{{ cellName(cell.id) }}</span>
              <span
                v-if="cellPrice(cell.id) !== null"
                class="property-price"
                :title="`Рента базовая: ${cellRent(cell.id) ?? 0}₽`"
                >{{ fmt(cellPrice(cell.id)!) }}₽</span
              >
              <span v-if="cell.houses > 0" class="badge-mortgaged">
                {{ cell.houses === 5 ? "отель" : `${cell.houses} дом.` }}
              </span>
              <span v-else-if="isMortgaged(cell.id)" class="badge-mortgaged">заложена</span>
            </button>
          </div>
        </div>
      </div>

      <div v-if="trade.lastError" class="error-banner">⚠️ {{ trade.lastError }}</div>

      <div class="trade-actions">
        <button class="action-btn btn-cancel" @click="onClose">Отмена</button>
        <button
          class="action-btn btn-accept"
          :disabled="blockedByPartner || iBlocked || trade.isDraftEmpty()"
          @click="onPropose"
        >
          🤝 Отправить предложение
        </button>
      </div>
    </div>

    <!-- Экран 3: уведомление о результате  -->
    <div
      v-else-if="isResultScreen && trade.lastResult"
      class="trade-result-card"
      :class="`result-${trade.lastResult.status}`"
    >
      <div class="result-icon" aria-hidden="true">
        <template v-if="trade.lastResult.status === 'accepted'">🎉</template>
        <template v-else-if="trade.lastResult.status === 'rejected'">❌</template>
        <template v-else>🚫</template>
      </div>

      <div class="result-title">{{ trade.lastResult.title }}</div>

      <div v-if="trade.lastResult.partnerName" class="result-partner">
        Партнёр: <strong>{{ trade.lastResult.partnerName }}</strong>
      </div>

      <div v-if="trade.lastResult.details" class="result-details">
        {{ trade.lastResult.details }}
      </div>

      <div class="result-hint">
        {{
          trade.lastResult.status === "accepted"
            ? "Поздравляем! Проверьте обновлённое состояние в журнале."
            : "Окно можно закрыть только нажав кнопку ниже."
        }}
      </div>

      <div class="result-actions">
        <button class="action-btn btn-acknowledge" @click="onAcknowledgeResult">Принять</button>
      </div>
    </div>
  </Modal>
</template>

<style scoped>
.trade-card,
.compose-card,
.partner-picker,
.trade-result-card {
  font-size: 13px;
  width: 100%;
  max-width: 100%;
  min-width: 0;
  box-sizing: border-box;
  overflow: hidden;
}
.trade-card *,
.compose-card *,
.partner-picker *,
.trade-result-card * {
  box-sizing: border-box;
  min-width: 0;
}

.partner-picker {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 4px 2px;
}
.picker-hint {
  text-align: center;
  font-size: 12px;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 4px;
}
.partner-list {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 10px;
  width: 100%;
}
.partner-card {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  background: var(--surface-3, rgba(255, 255, 255, 0.04));
  border: 1px solid var(--glass-border, rgba(255, 255, 255, 0.12));
  border-radius: 8px;
  cursor: pointer;
  transition:
    transform 0.15s ease,
    border-color 0.15s ease,
    background 0.15s ease;
  min-width: 0;
  overflow: hidden;
}
.partner-card:hover {
  transform: translateY(-1px);
  border-color: var(--accent, #6cf2c8);
  background: var(--surface-3-hover, rgba(255, 255, 255, 0.08));
}
.partner-card.blocked {
  opacity: 0.55;
  cursor: not-allowed;
}
.partner-card.blocked:hover {
  transform: none;
  border-color: var(--glass-border, rgba(255, 255, 255, 0.12));
}
.partner-icon {
  font-size: 22px;
  line-height: 1;
  flex-shrink: 0;
}
.partner-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  flex: 1 1 auto;
}
.partner-name {
  font-weight: 700;
  font-size: 13px;
  color: var(--text, #fff);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.partner-meta {
  font-size: 11px;
  color: var(--text-muted, rgba(255, 255, 255, 0.6));
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.blocked-note {
  font-size: 10px;
  color: #ff7676;
  margin-top: 2px;
  text-transform: uppercase;
  letter-spacing: 0.3px;
}

.compose-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
  flex-wrap: wrap;
}
.compose-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 700;
  font-size: 14px;
  color: var(--text, #fff);
  flex: 1 1 auto;
  min-width: 0;
}
.compose-title .icon {
  font-size: 16px;
  line-height: 1;
}
.compose-title .arrow {
  font-size: 18px;
  color: var(--accent, #6cf2c8);
  font-weight: 700;
  margin: 0 2px;
}
.back-btn {
  background: var(--surface-2, rgba(255, 255, 255, 0.05));
  border: 1px solid var(--glass-border, rgba(255, 255, 255, 0.12));
  color: var(--text, #fff);
  border-radius: var(--radius-sm, 6px);
  padding: 8px 12px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition:
    background 0.2s,
    border-color 0.2s;
}
.back-btn:hover {
  background: var(--surface-3, rgba(255, 255, 255, 0.08));
  border-color: var(--accent, #6cf2c8);
}
.error-banner,
.warn-banner {
  width: 100%;
  padding: 10px 12px;
  border-radius: var(--radius-sm, 6px);
  font-size: 12px;
  font-weight: 600;
  margin-bottom: 12px;
  text-align: center;
}
.error-banner {
  background: rgba(255, 80, 80, 0.12);
  border: 1px solid rgba(255, 80, 80, 0.5);
  color: #ff8a8a;
}
.warn-banner {
  background: rgba(255, 200, 0, 0.1);
  border: 1px solid rgba(255, 200, 0, 0.45);
  color: #ffd97a;
}
.compose-sides {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
  margin-bottom: 14px;
}
@media (max-width: 640px) {
  .compose-sides {
    grid-template-columns: 1fr;
  }
}
.compose-side {
  background: var(--surface-3, rgba(255, 255, 255, 0.04));
  border: 1px solid var(--glass-border, rgba(255, 255, 255, 0.1));
  border-radius: 8px;
  padding: 10px 12px;
  min-width: 0;
  overflow: hidden;
}
.cash-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 8px 0;
  flex-wrap: wrap;
}
.cash-row label {
  flex: 0 0 auto;
  font-size: 12px;
  color: var(--text-muted, rgba(255, 255, 255, 0.65));
  font-weight: 600;
}
.cash-row input {
  flex: 1 1 80px;
  min-width: 80px;
  padding: 10px 12px;
  background: var(--surface-2, rgba(255, 255, 255, 0.05));
  border: 1px solid var(--glass-border, rgba(255, 255, 255, 0.12));
  border-radius: var(--radius-sm, 6px);
  color: var(--text, #fff);
  font-family: "Space Grotesk", monospace;
  font-size: 14px;
  font-weight: 700;
  outline: none;
  transition: border-color 0.2s;
}
.cash-row input:focus {
  border-color: var(--accent, #6cf2c8);
}
.cash-row input:disabled {
  opacity: 0.5;
}
.cash-row input::-webkit-outer-spin-button,
.cash-row input::-webkit-inner-spin-button {
  -webkit-appearance: none;
  margin: 0;
}
.cash-row input[type="number"] {
  -moz-appearance: textfield;
  appearance: textfield;
}
.cash-hint {
  font-size: 11px;
  color: var(--text-muted, rgba(255, 255, 255, 0.55));
  white-space: nowrap;
}
.property-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 8px;
  margin-top: 6px;
  max-height: 220px;
  overflow-y: auto;
  padding-right: 2px;
}
.property-card {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  padding: 8px 10px;
  background: var(--surface-2, rgba(255, 255, 255, 0.04));
  border: 1px solid var(--glass-border, rgba(255, 255, 255, 0.12));
  border-left: 4px solid var(--glass-border, rgba(255, 255, 255, 0.12));
  border-radius: var(--radius-sm, 6px);
  color: var(--text, #fff);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  text-align: left;
  min-width: 0;
  overflow: hidden;
  transition:
    background 0.15s,
    border-color 0.15s,
    transform 0.15s;
}
.property-card:hover {
  background: var(--surface-3, rgba(255, 255, 255, 0.08));
  transform: translateY(-1px);
}
.property-card.selected {
  background: rgba(108, 242, 200, 0.12);
  border-color: var(--accent, #6cf2c8);
  box-shadow: 0 0 0 1px var(--accent, #6cf2c8) inset;
}
.property-card .cell-color {
  width: 100%;
  height: 6px;
  border-radius: 3px;
  margin-bottom: 2px;
}
.property-name {
  font-size: 12px;
  font-weight: 700;
  line-height: 1.2;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  width: 100%;
}
.property-price {
  font-size: 11px;
  color: var(--text-muted, rgba(255, 255, 255, 0.6));
  font-family: "Space Grotesk", monospace;
}
.property-card .badge-mortgaged {
  font-size: 9px;
  text-transform: uppercase;
  letter-spacing: 0.4px;
  color: #ff8a8a;
  margin-top: 2px;
}
.compose-card .empty,
.compose-card .partner-picker .empty {
  font-size: 12px;
  color: var(--text-muted, rgba(255, 255, 255, 0.55));
  text-align: center;
  padding: 8px;
  font-style: italic;
}

.phase-banner {
  text-align: center;
  padding: 10px;
  border-radius: 6px;
  margin-bottom: 12px;
  font-size: 12px;
  font-weight: 600;
}
.phase-banner.your-turn {
  background: var(--surface-2);
  border: 1px solid var(--accent);
  color: var(--accent);
}
.phase-banner.wait {
  background: var(--surface-2);
  border: 1px solid var(--glass-border);
  color: var(--text-muted);
}
.phase-banner.confirm {
  background: var(--surface-2);
  border: 1px solid var(--gold, #c8a955);
  color: var(--gold, #c8a955);
}

.trade-sides {
  display: flex;
  align-items: stretch;
  gap: 10px;
  margin-bottom: 16px;
  flex-wrap: wrap;
}
.trade-side {
  flex: 1 1 240px;
  min-width: 0;
  max-width: 100%;
  background: var(--surface-3);
  border-radius: 8px;
  padding: 10px;
  overflow: hidden;
}
.side-title {
  font-weight: 700;
  font-size: 13px;
  margin-bottom: 8px;
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.side-title .icon {
  font-size: 16px;
}
.side-section {
  margin-top: 6px;
  min-width: 0;
}
.section-label {
  font-size: 11px;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 4px;
  margin-top: 8px;
}

.trade-result-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  padding: 18px 14px 14px;
  gap: 10px;
}
.trade-result-card.result-accepted {
  background: linear-gradient(
    180deg,
    rgba(80, 200, 120, 0.12),
    rgba(80, 200, 120, 0.02) 60%,
    transparent
  );
  border-radius: 10px;
}
.trade-result-card.result-rejected {
  background: linear-gradient(
    180deg,
    rgba(220, 80, 80, 0.12),
    rgba(220, 80, 80, 0.02) 60%,
    transparent
  );
  border-radius: 10px;
}
.trade-result-card.result-cancelled {
  background: linear-gradient(
    180deg,
    rgba(200, 200, 100, 0.12),
    rgba(200, 200, 100, 0.02) 60%,
    transparent
  );
  border-radius: 10px;
}
.result-icon {
  font-size: 56px;
  line-height: 1;
  margin-top: 4px;
  margin-bottom: 4px;
  filter: drop-shadow(0 4px 12px rgba(0, 0, 0, 0.4));
  animation: resultPop 0.45s cubic-bezier(0.34, 1.56, 0.64, 1) both;
}
@keyframes resultPop {
  0% {
    transform: scale(0.3);
    opacity: 0;
  }
  60% {
    transform: scale(1.15);
    opacity: 1;
  }
  100% {
    transform: scale(1);
    opacity: 1;
  }
}
.result-title {
  font-size: 20px;
  font-weight: 700;
  line-height: 1.2;
}
.result-partner {
  font-size: 13px;
  color: var(--text-muted);
}
.result-partner strong {
  color: var(--text);
}
.result-details {
  font-size: 13px;
  line-height: 1.4;
  max-width: 480px;
  padding: 8px 10px;
  background: var(--surface-2);
  border-radius: 6px;
  border: 1px solid var(--glass-border);
  color: var(--text-muted);
  word-wrap: break-word;
  overflow-wrap: anywhere;
}
.result-hint {
  font-size: 12px;
  color: var(--text-muted);
  margin-top: 4px;
}
.result-actions {
  margin-top: 14px;
  width: 100%;
  display: flex;
  justify-content: center;
}

.trade-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 12px;
  flex-wrap: wrap;
}
.action-btn {
  border: 0;
  border-radius: 6px;
  padding: 8px 14px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  background: var(--surface-3);
  color: var(--text);
  transition:
    filter 0.15s,
    transform 0.15s;
}
.action-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.action-btn:not(:disabled):hover {
  filter: brightness(1.15);
}
.action-btn:not(:disabled):active {
  transform: scale(0.98);
}
.btn-accept {
  background: linear-gradient(180deg, #2ea043, #1f7a35);
  color: #fff;
}
.btn-reject {
  background: linear-gradient(180deg, #b62324, #8a1c1c);
  color: #fff;
}
.btn-counter {
  background: linear-gradient(180deg, #1f6feb, #1a5fbe);
  color: #fff;
}
.btn-cancel {
  background: var(--surface-3);
  color: var(--text-muted);
}
.btn-acknowledge {
  min-width: 220px;
  padding: 12px 28px;
  font-size: 15px;
  font-weight: 700;
  background: linear-gradient(180deg, #2ea043, #1f7a35);
  color: #fff;
  border-radius: 8px;
  box-shadow: 0 4px 14px rgba(46, 160, 67, 0.35);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  transition:
    filter 0.15s,
    transform 0.15s,
    box-shadow 0.15s;
}
.btn-acknowledge:hover {
  filter: brightness(1.1);
  box-shadow: 0 6px 18px rgba(46, 160, 67, 0.5);
}
.btn-acknowledge:active {
  transform: scale(0.98);
}
</style>
