<script setup lang="ts">
import { useRouter } from "vue-router";
import { ref } from "vue";
import { useGameStore } from "../stores/game";

const router = useRouter();
const game = useGameStore();

const playerName = localStorage.getItem("playerName") || "Гость";

// Тип any[] — потом заменим на Game[]
const games = ref<any[]>([]);

// Флаг видимости модалки создания игры
const showCreate = ref(false);

// Поля формы создания игры
const newGameName = ref("");
const botCount = ref(3); // по умолчанию 3 бота

// Функция создания игры
function createGame() {
  // Валидация: название не должно быть пустым
  if (!newGameName.value.trim()) return;

  // Формируем список игроков: реальный пользователь + боты
  const me = localStorage.getItem("playerName") || "Игрок";
  const botNames = ["Бот 1", "Бот 2", "Бот 3"];
  const names = [me, ...botNames.slice(0, botCount.value)];

  game.initGame(names);

  router.push(`/game/${game.state.id}`);
}

// Заглушки для будущих кнопок
function joinGame(gameId: string) {
  router.push(`/game/${gameId}`);
}
</script>

<template>
  <!-- Главный контейнер -->
  <div class="lobby-container">
    <!-- Шапка с логотипом и именем игрока -->
    <div class="lobby-header">
      <div class="logo-small">Монополия</div>
      <div class="user-info">👤 {{ playerName }}</div>
    </div>

    <!-- Основной контент -->
    <div class="lobby-content">
      <!-- Панель со списком игр -->
      <div class="panel">
        <div class="panel-title">Доступные игры</div>

        <div v-if="games.length === 0" class="empty-state">
          🎲 Пока нет активных игр. Создай первую!
        </div>

        <div v-else class="games-list">
          <div v-for="g in games" :key="g.id" class="game-card">
            <div class="game-name">{{ g.name }}</div>
            <button class="action-btn btn-roll" @click="joinGame(g.id)">Войти</button>
          </div>
        </div>
      </div>

      <!-- Кнопка создания новой игры -->
      <button class="action-btn btn-buy create-btn" @click="showCreate = true">
        ➕ Создать новую игру
      </button>
    </div>

    <!-- Модалка создания игры -->
    <div v-if="showCreate" class="modal-overlay active" @click.self="showCreate = false">
      <div class="modal">
        <div class="modal-title">🎮 Новая игра</div>

        <div class="form-group">
          <label>Название</label>
          <input v-model="newGameName" type="text" placeholder="Моя партия" />
        </div>

        <div class="form-group">
          <label>Количество ботов</label>
          <select v-model.number="botCount">
            <option :value="0">Без ботов (только я)</option>
            <option :value="1">1 бот</option>
            <option :value="2">2 бота</option>
            <option :value="3">3 бота</option>
          </select>
        </div>

        <div class="modal-actions">
          <button class="action-btn btn-roll" @click="createGame">Создать</button>
          <button class="action-btn btn-cancel" @click="showCreate = false">Отмена</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.lobby-container {
  min-height: 100vh;
  padding: 20px;
  max-width: 900px;
  margin: 0 auto;
}

.lobby-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px 24px;
  margin-bottom: 24px;
  background: var(--glass);
  backdrop-filter: blur(24px);
  border-radius: var(--radius);
  border: 1px solid var(--glass-border);
}

.logo-small {
  font-family: "Space Grotesk", sans-serif;
  font-size: 22px;
  font-weight: 700;
  background: linear-gradient(135deg, var(--gold), var(--accent));
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
  text-transform: uppercase;
  letter-spacing: 3px;
}

.user-info {
  font-size: 13px;
  color: var(--text2);
}

.empty-state {
  padding: 60px 20px;
  text-align: center;
  font-size: 14px;
  color: var(--text3);
}

.create-btn {
  margin-top: 24px;
  width: 100%;
  font-size: 14px;
  padding: 16px;
}

.form-group {
  margin-bottom: 16px;
}

.form-group label {
  display: block;
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 2px;
  color: var(--text2);
  margin-bottom: 6px;
}

.form-group input,
.form-group select {
  width: 100%;
  padding: 10px 14px;
  background: var(--surface-1);
  border: 1px solid var(--glass-border);
  border-radius: 10px;
  color: var(--text);
  font-size: 14px;
  outline: none;
}

.form-group select {
  cursor: pointer;
  appearance: none;
  background-image: url("data:image/svg+xml;utf8,<svg fill='white' viewBox='0 0 24 24'><path d='M7 10l5 5 5-5z'/></svg>");
  background-repeat: no-repeat;
  background-position: right 12px center;
  background-size: 16px;
  padding-right: 36px;
}

.btn-cancel {
  background: var(--surface-3);
  color: var(--text);
  border: 1px solid var(--glass-border);
  flex: 1;
}

.action-btn {
  flex: 1;
  min-width: 100px;
  padding: 13px 16px;
  border: none;
  border-radius: var(--radius-sm);
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
  text-transform: uppercase;
  letter-spacing: 1px;
  transition: all 0.25s var(--ease-out);
}

.btn-roll {
  background: linear-gradient(135deg, var(--accent), var(--accent2));
  color: #fff;
}

.btn-buy {
  background: linear-gradient(135deg, var(--green), var(--accent));
  color: #fff;
}

@media (max-width: 600px) {
  .lobby-header {
    flex-direction: column;
    gap: 12px;
    text-align: center;
  }
}
</style>
