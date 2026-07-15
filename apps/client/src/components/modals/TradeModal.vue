<script setup lang="ts">
import { ref, computed, watch } from "vue";
import Modal from "../Modal.vue";
import type { Cell, GameState, Player, TradeOffer } from "@monopoly/shared";

/**
 * TradeModal — модалка обмена.
 *
 * Используется в двух режимах:
 *  - TRADING_NEGOTIATE: инициатор формирует оффер, получатель отвечает.
 *  - TRADING_CONFIRM: инициатор подтверждает встречное предложение.
 *
 * Модалка получает весь `state`, чтобы показать обе стороны
 * (инициатор ↔ получатель) и их имущество.
 */
const props = defineProps<{
  show: boolean;
  state: GameState;
  /** ID игрока, для которого сейчас открыта модалка (currentPartyId или initiator). */
  myPlayerId: string;
  /** true — режим подтверждения (только кнопки accept/reject). */
  isConfirmPhase?: boolean;
}>();

const emit = defineEmits<{
  (e: "accept"): void;
  (e: "reject"): void;
  (e: "counter", offer: TradeOffer): void;
  (e: "cancel"): void;
  (e: "close"): void;
}>();

const trade = computed(() => props.state.trade);

const initiator = computed<Player | null>(() => {
  if (!trade.value) return null;
  return props.state.players.find((p) => p.id === trade.value!.initiatorId) ?? null;
});

const recipient = computed<Player | null>(() => {
  if (!trade.value) return null;
  return props.state.players.find((p) => p.id === trade.value!.recipientId) ?? null;
});

const isInitiatorView = computed(() => {
  if (!trade.value) return false;
  return props.myPlayerId === trade.value.initiatorId;
});

const myPlayer = computed<Player | null>(() => {
  return props.state.players.find((p) => p.id === props.myPlayerId) ?? null;
});

const opponent = computed<Player | null>(() => {
  if (isInitiatorView.value) return recipient.value;
  return initiator.value;
});

const currentOffer = computed<TradeOffer | null>(() => trade.value?.offer ?? null);

// "С моей стороны" — то, что я отдаю
const mySideGives = computed(() => {
  if (!currentOffer.value) return { properties: [] as number[], cash: 0 };
  return isInitiatorView.value
    ? {
        properties: currentOffer.value.fromProperties,
        cash: currentOffer.value.fromCash,
      }
    : {
        properties: currentOffer.value.toProperties,
        cash: currentOffer.value.toCash,
      };
});

const mySideReceives = computed(() => {
  if (!currentOffer.value) return { properties: [] as number[], cash: 0 };
  return isInitiatorView.value
    ? {
        properties: currentOffer.value.toProperties,
        cash: currentOffer.value.toCash,
      }
    : {
        properties: currentOffer.value.fromProperties,
        cash: currentOffer.value.fromCash,
      };
});

const counterCount = computed(() => trade.value?.counterCount ?? 0);
const maxCounter = computed(() => props.state.settings.tradingMaxCounterOffers ?? 3);

const cellName = (id: number): string => props.state.board[id]?.name ?? `#${id}`;

const cellColor = (id: number): string => props.state.board[id]?.color ?? "#888";

const canCounter = computed(() => counterCount.value < maxCounter.value);
</script>

<template>
  <Modal
    :show="show"
    :title="isConfirmPhase ? '✅ Подтверждение обмена' : '🤝 Обмен'"
    :subtitle="initiator && recipient ? `${initiator.displayName} ↔ ${recipient.displayName}` : ''"
    @close="emit('close')"
  >
    <div v-if="trade && currentOffer" class="trade-card">
      <div class="trade-sides">
        <!-- Я отдаю -->
        <div class="trade-side">
          <div class="side-title">
            <span class="icon" :style="{ color: myPlayer?.color }">●</span>
            <span>{{ myPlayer?.displayName }} (вы)</span>
          </div>
          <div class="side-section">
            <div class="section-label">Отдаёте</div>
            <div v-if="mySideGives.properties.length === 0 && mySideGives.cash === 0" class="empty">
              ничего
            </div>
            <div v-else class="items">
              <div
                v-for="pid in mySideGives.properties"
                :key="`give-prop-${pid}`"
                class="item"
                :style="{ borderColor: cellColor(pid) }"
              >
                <span class="cell-color" :style="{ background: cellColor(pid) }"></span>
                {{ cellName(pid) }}
              </div>
              <div v-if="mySideGives.cash > 0" class="item cash">₽{{ mySideGives.cash }}</div>
            </div>
          </div>
          <div class="side-section">
            <div class="section-label">Получаете</div>
            <div
              v-if="mySideReceives.properties.length === 0 && mySideReceives.cash === 0"
              class="empty"
            >
              ничего
            </div>
            <div v-else class="items">
              <div
                v-for="pid in mySideReceives.properties"
                :key="`recv-prop-${pid}`"
                class="item"
                :style="{ borderColor: cellColor(pid) }"
              >
                <span class="cell-color" :style="{ background: cellColor(pid) }"></span>
                {{ cellName(pid) }}
              </div>
              <div v-if="mySideReceives.cash > 0" class="item cash">₽{{ mySideReceives.cash }}</div>
            </div>
          </div>
        </div>

        <div class="trade-arrow">⇄</div>

        <!-- Противник -->
        <div class="trade-side">
          <div class="side-title">
            <span class="icon" :style="{ color: opponent?.color }">●</span>
            <span>{{ opponent?.displayName }}</span>
          </div>
          <div class="side-section">
            <div class="section-label">Отдаёт</div>
            <div
              v-if="mySideReceives.properties.length === 0 && mySideReceives.cash === 0"
              class="empty"
            >
              ничего
            </div>
            <div v-else class="items">
              <div
                v-for="pid in mySideReceives.properties"
                :key="`opp-give-prop-${pid}`"
                class="item"
                :style="{ borderColor: cellColor(pid) }"
              >
                <span class="cell-color" :style="{ background: cellColor(pid) }"></span>
                {{ cellName(pid) }}
              </div>
              <div v-if="mySideReceives.cash > 0" class="item cash">₽{{ mySideReceives.cash }}</div>
            </div>
          </div>
        </div>
      </div>

      <div v-if="isConfirmPhase" class="confirm-banner">
        ⏳ Инициатор должен подтвердить изменённые условия.
      </div>

      <div class="trade-meta">
        <small>Встречных предложений: {{ counterCount }}/{{ maxCounter }}</small>
      </div>

      <div class="trade-actions">
        <template v-if="!isConfirmPhase">
          <button class="action-btn btn-accept" @click="emit('accept')">✅ Принять</button>
          <button
            class="action-btn btn-counter"
            :disabled="!canCounter"
            @click="emit('counter', currentOffer)"
          >
            ↩️ Встречное ({{ counterCount }}/{{ maxCounter }})
          </button>
          <button class="action-btn btn-reject" @click="emit('reject')">❌ Отклонить</button>
          <button v-if="isInitiatorView" class="action-btn btn-cancel" @click="emit('cancel')">
            Отменить
          </button>
        </template>
        <template v-else>
          <button class="action-btn btn-accept" @click="emit('accept')">✅ Подтвердить</button>
          <button class="action-btn btn-reject" @click="emit('reject')">❌ Отклонить</button>
        </template>
      </div>
    </div>
  </Modal>
</template>

<style scoped>
.trade-card {
  font-size: 13px;
}

.trade-sides {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 16px;
}

.trade-side {
  flex: 1;
  background: var(--surface-3);
  border-radius: 8px;
  padding: 10px;
}

.side-title {
  font-weight: 700;
  font-size: 13px;
  margin-bottom: 8px;
  display: flex;
  align-items: center;
  gap: 6px;
}

.side-title .icon {
  font-size: 16px;
}

.side-section {
  margin-top: 6px;
}

.section-label {
  font-size: 11px;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 4px;
}

.items {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  border: 1px solid var(--glass-border);
  border-radius: 4px;
  font-size: 12px;
  border-left-width: 4px;
  background: var(--surface-2);
}

.item.cash {
  border-left-color: var(--gold);
  color: var(--gold);
  font-weight: 700;
}

.cell-color {
  display: inline-block;
  width: 10px;
  height: 10px;
  border-radius: 2px;
}

.empty {
  font-style: italic;
  color: var(--text-muted);
  font-size: 11px;
}

.trade-arrow {
  font-size: 28px;
  color: var(--accent);
  font-weight: 700;
}

.trade-meta {
  font-size: 11px;
  color: var(--text-muted);
  text-align: center;
  margin: 8px 0 12px;
}

.trade-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.action-btn {
  flex: 1;
  min-width: 110px;
  padding: 10px 12px;
  border: none;
  border-radius: 6px;
  font-weight: 700;
  font-size: 12px;
  cursor: pointer;
  text-transform: uppercase;
}

.action-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.btn-accept {
  background: linear-gradient(135deg, var(--green), var(--accent));
  color: #fff;
}

.btn-reject {
  background: linear-gradient(135deg, var(--accent2), #c33);
  color: #fff;
}

.btn-counter {
  background: var(--surface-3);
  color: var(--text);
  border: 1px solid var(--glass-border);
}

.btn-cancel {
  background: var(--surface-3);
  color: var(--text);
  border: 1px solid var(--glass-border);
}

.confirm-banner {
  text-align: center;
  padding: 10px;
  background: var(--surface-2);
  border: 1px solid var(--glass-border);
  border-radius: 6px;
  margin-bottom: 12px;
  font-size: 12px;
}
</style>
