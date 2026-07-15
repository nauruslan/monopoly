import { defineStore } from "pinia";
import { ref, watch } from "vue";

/**
 * Pinia-стор клиентских UI-настроек.
 *
 * Сохраняется в localStorage и автоматически подхватывается на старте.
 */

const STORAGE_KEY = "monopoly-settings";

export interface ClientSettings {
  soundEnabled: boolean;
  confettiEnabled: boolean;
  animationSpeed: 0.5 | 1 | 2;
}

const defaults: ClientSettings = {
  soundEnabled: true,
  confettiEnabled: true,
  animationSpeed: 1,
};

export const useSettingsStore = defineStore("settings", () => {
  const soundEnabled = ref<boolean>(defaults.soundEnabled);
  const confettiEnabled = ref<boolean>(defaults.confettiEnabled);
  const animationSpeed = ref<0.5 | 1 | 2>(defaults.animationSpeed);

  // Загружаем из localStorage при инициализации стора.
  if (typeof window !== "undefined") {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const s = JSON.parse(raw) as Partial<ClientSettings>;
        if (typeof s.soundEnabled === "boolean") soundEnabled.value = s.soundEnabled;
        if (typeof s.confettiEnabled === "boolean") confettiEnabled.value = s.confettiEnabled;
        if (s.animationSpeed === 0.5 || s.animationSpeed === 1 || s.animationSpeed === 2) {
          animationSpeed.value = s.animationSpeed;
        }
      }
    } catch {
      // Невалидный JSON — оставляем defaults.
    }
  }

  // Автосохранение при изменении любой настройки.
  watch([soundEnabled, confettiEnabled, animationSpeed], () => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          soundEnabled: soundEnabled.value,
          confettiEnabled: confettiEnabled.value,
          animationSpeed: animationSpeed.value,
        }),
      );
    } catch {
      // localStorage может быть недоступен (private mode) — игнорируем.
    }
  });

  return { soundEnabled, confettiEnabled, animationSpeed };
});
