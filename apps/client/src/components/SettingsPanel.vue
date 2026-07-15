<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from "vue";
import { useSettingsStore } from "../stores/settings";
import { useGameStore } from "../stores/game";
import { useAuthStore } from "../stores/auth";

/**
 * Панель UI-настроек, портирована из
 *
 * Содержит:
 *  - Тогглы «Звуки» и «Конфетти»
 *  - Селектор «Скорость анимации» (0.5× / 1× / 2×)
 *  - Кнопки «Сохранить» / «Загрузить» (REST /games/:id/save, /load)
 */
const settings = useSettingsStore();
const game = useGameStore();
const auth = useAuthStore();
const isOpen = ref(false);

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:3000";

async function handleSave() {
  const gameId = game.state?.id;
  if (!gameId) return;
  const token = auth.token;
  if (!token) {
    alert("Сначала войдите в игру");
    return;
  }
  try {
    const res = await fetch(`${API_URL}/games/${gameId}/save`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const json = await res.json();
    if (!json.ok) {
      alert("Ошибка сохранения: " + (json.error ?? res.status));
      return;
    }
    // Скачиваем как JSON-файл.
    const blob = new Blob([JSON.stringify(json.data, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `monopoly-save-${gameId}-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (e) {
    alert("Ошибка сохранения: " + (e instanceof Error ? e.message : String(e)));
  }
}

async function handleLoad() {
  const gameId = game.state?.id;
  if (!gameId) return;
  const token = auth.token;
  if (!token) {
    alert("Сначала войдите в игру");
    return;
  }
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "application/json";
  input.onchange = async (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    let parsed: { state?: unknown };
    try {
      const text = await file.text();
      parsed = JSON.parse(text);
    } catch {
      alert("Невалидный JSON");
      return;
    }
    if (!parsed?.state || typeof parsed.state !== "object") {
      alert("В файле нет поля state");
      return;
    }
    try {
      const res = await fetch(`${API_URL}/games/${gameId}/load`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ state: parsed.state }),
      });
      const json = await res.json();
      if (!json.ok) {
        alert("Ошибка загрузки: " + (json.error ?? res.status));
        return;
      }
      // Обновляем локальный стор свежим state (ref-присвоение).
      if (json.data?.state) {
        game.state = json.data.state as typeof game.state;
      }
      alert("Партия загружена!");
    } catch (err) {
      alert("Ошибка загрузки: " + (err instanceof Error ? err.message : String(err)));
    }
  };
  input.click();
}

function toggle() {
  isOpen.value = !isOpen.value;
}

function closeOnOutsideClick(e: MouseEvent) {
  const panel = document.getElementById("settingsPanel");
  const btn = document.getElementById("settingsBtn");
  if (!panel || !btn) return;
  if (!panel.contains(e.target as Node) && e.target !== btn) {
    isOpen.value = false;
  }
}

onMounted(() => {
  document.addEventListener("click", closeOnOutsideClick);
});
onBeforeUnmount(() => {
  document.removeEventListener("click", closeOnOutsideClick);
});
</script>

<template>
  <button id="settingsBtn" class="settings-btn" title="Настройки" @click="toggle">⚙️</button>

  <div id="settingsPanel" class="settings-panel" :class="{ active: isOpen }">
    <div class="panel-title">Настройки</div>

    <div class="setting-row">
      <div>
        <div class="setting-label">🔊 Звуки</div>
        <div class="setting-desc">Звуковые эффекты</div>
      </div>
      <div
        class="toggle"
        :class="{ active: settings.soundEnabled }"
        @click="settings.soundEnabled = !settings.soundEnabled"
      ></div>
    </div>

    <div class="setting-row">
      <div>
        <div class="setting-label">⚡ Скорость</div>
        <div class="setting-desc">Скорость анимаций</div>
      </div>
      <div class="speed-selector">
        <button
          v-for="s in [0.5, 1, 2]"
          :key="s"
          class="speed-btn"
          :class="{ active: settings.animationSpeed === s }"
          @click="settings.animationSpeed = s as 0.5 | 1 | 2"
        >
          {{ s }}×
        </button>
      </div>
    </div>

    <div class="setting-row">
      <div>
        <div class="setting-label">✨ Конфетти</div>
        <div class="setting-desc">Эффекты при покупке</div>
      </div>
      <div
        class="toggle"
        :class="{ active: settings.confettiEnabled }"
        @click="settings.confettiEnabled = !settings.confettiEnabled"
      ></div>
    </div>

    <div class="setting-row">
      <div>
        <div class="setting-label">💾 Сохранение</div>
        <div class="setting-desc">Скачать / загрузить партию</div>
      </div>
      <div class="save-load-btns">
        <button class="save-load-btn" @click="handleSave">Сохранить</button>
        <button class="save-load-btn" @click="handleLoad">Загрузить</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.settings-btn {
  position: fixed;
  top: 16px;
  right: 16px;
  width: 44px;
  height: 44px;
  border-radius: 12px;
  border: 1px solid rgba(255, 255, 255, 0.2);
  background: rgba(255, 255, 255, 0.05);
  backdrop-filter: blur(12px);
  color: #fff;
  font-size: 18px;
  cursor: pointer;
  z-index: 100;
  transition: all 0.25s ease;
}
.settings-btn:hover {
  background: rgba(255, 255, 255, 0.1);
  transform: rotate(45deg);
  border-color: #9b6dff;
}
.settings-panel {
  position: fixed;
  top: 68px;
  right: 16px;
  width: 280px;
  background: rgba(23, 9, 45, 0.98);
  backdrop-filter: blur(24px);
  border-radius: 12px;
  padding: 20px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
  border: 1px solid rgba(255, 255, 255, 0.1);
  z-index: 99;
  display: none;
  color: #fff;
}
.settings-panel.active {
  display: block;
}
.setting-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 0;
  border-bottom: 1px solid rgba(255, 255, 255, 0.05);
}
.setting-row:last-child {
  border-bottom: none;
}
.setting-label {
  font-size: 14px;
  font-weight: 600;
}
.setting-desc {
  font-size: 12px;
  opacity: 0.6;
  margin-top: 2px;
}
.toggle {
  width: 40px;
  height: 22px;
  border-radius: 11px;
  background: rgba(255, 255, 255, 0.1);
  cursor: pointer;
  position: relative;
  transition: background 0.2s;
  flex-shrink: 0;
}
.toggle.active {
  background: #9b6dff;
}
.toggle::after {
  content: "";
  position: absolute;
  top: 2px;
  left: 2px;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: #fff;
  transition: transform 0.2s;
}
.toggle.active::after {
  transform: translateX(18px);
}
.speed-selector {
  display: flex;
  gap: 4px;
}
.speed-btn {
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.1);
  color: #fff;
  padding: 4px 10px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 12px;
}
.speed-btn.active {
  background: #9b6dff;
  border-color: #9b6dff;
}
.save-load-btns {
  display: flex;
  gap: 4px;
}
.save-load-btn {
  background: rgba(155, 109, 255, 0.2);
  border: 1px solid rgba(155, 109, 255, 0.5);
  color: #fff;
  padding: 6px 10px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 12px;
  transition: background 0.2s;
}
.save-load-btn:hover {
  background: rgba(155, 109, 255, 0.4);
}
</style>
