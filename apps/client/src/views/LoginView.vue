<script setup lang="ts">
import { ref } from "vue";
import { useRouter } from "vue-router";
import { useAuthStore } from "../stores/auth";

const router = useRouter();
const auth = useAuthStore();
const playerName = ref("");
const loading = ref(false);
const error = ref<string | null>(null);

async function playAsGuest() {
  if (!playerName.value.trim()) {
    alert("Введите имя!");
    return;
  }
  loading.value = true;
  error.value = null;
  try {
    // Сначала получаем токен от сервера через auth.loginAsGuest(name).
    // Метод сам положит accessToken/refreshToken/userId в стор и в localStorage.
    await auth.loginAsGuest(playerName.value);
    // Затем сохраняем отображаемое имя (для UI в LobbyView) и идём в лобби.
    localStorage.setItem("playerName", playerName.value);
    router.push("/lobby");
  } catch (e: any) {
    console.error("loginAsGuest failed:", e);
    error.value = e?.message ?? "Не удалось войти как гость";
    alert(error.value);
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <!-- Главный контейнер по центру экрана -->
  <div class="login-container">
    <!-- Карточка с формой -->
    <div class="login-card">
      <!-- Логотип с градиентом -->
      <div class="logo">Монополия</div>
      <div class="logo-sub">neon edition</div>

      <!-- Группа поля ввода -->
      <div class="form-group">
        <label>Ваше имя</label>
        <input
          v-model="playerName"
          type="text"
          placeholder="Игрок 1"
          maxlength="20"
          :disabled="loading"
          @keyup.enter="playAsGuest"
        />
      </div>

      <button class="action-btn btn-roll" :disabled="loading" @click="playAsGuest">
        <span v-if="loading">⏳ Входим...</span>
        <span v-else>🚀 Войти как гость</span>
      </button>

      <div v-if="error" class="error">{{ error }}</div>

      <!-- Подсказка -->
      <div class="hint">Позже добавим: регистрацию, статистику, мультиплеер</div>
    </div>
  </div>
</template>

<style scoped>
.login-container {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
}

.login-card {
  background: var(--glass);
  backdrop-filter: blur(24px);
  padding: 48px 40px;
  border: 1px solid var(--glass-border);
  box-shadow: var(--shadow-lg);
  text-align: center;
}

.logo {
  font-family: "Space Grotesk", sans-serif;
  font-size: 48px;
  font-weight: 700;
  background: linear-gradient(135deg, var(--gold), var(--accent), var(--accent2));
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
  text-transform: uppercase;
  letter-spacing: 4px;
  margin-bottom: 8px;
}

.logo-sub {
  font-size: 11px;
  color: var(--text3);
  letter-spacing: 7px;
  text-transform: uppercase;
  margin-bottom: 32px;
}

.form-group {
  margin-bottom: 24px;
  text-align: left;
}

.form-group label {
  display: block;
  font-size: 11px;
  font-weight: 800;
  text-transform: uppercase;
  letter-spacing: 3px;
  color: var(--text2);
  margin-bottom: 8px;
}

.form-group input {
  width: 100%;
  padding: 14px 16px;
  background: var(--surface-1);
  border: 1px solid var(--glass-border);
  border-radius: 12px;
  color: var(--text);
  font-size: 15px;
  outline: none;
  transition: all 0.2s;
}

.form-group input:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px rgba(129, 82, 207, 0.2);
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
  width: 100%;
}

.btn-roll {
  background: linear-gradient(135deg, var(--accent), var(--accent2));
  color: #fff;
  box-shadow: 0 4px 20px rgba(129, 82, 207, 0.5);
  font-size: 14px;
  padding: 16px;
}

.btn-roll:hover:not(:disabled) {
  transform: translateY(-2px);
}

.btn-roll:disabled {
  opacity: 0.6;
  cursor: wait;
  transform: none;
}

.error {
  margin-top: 16px;
  font-size: 12px;
  color: #ff6b6b;
}

.hint {
  margin-top: 24px;
  font-size: 11px;
  color: var(--text3);
}
</style>
