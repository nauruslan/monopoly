import { io, type Socket } from "socket.io-client";
import { ref } from "vue";

let socket: Socket | null = null;

/**
 * useSocket — singleton-подключение к WebSocket-серверу
 *
 * Один экземпляр Socket на всё приложение (singleton pattern)
 * Токен передаётся при подключении.
 *
 * ВАЖНО: если токен пустой (страница открыта до логина) — возвращаем null.
 * GameView должен сам разобраться: либо редиректить на /, либо показать
 * "Требуется войти".
 */
export function useSocket(token: string): Socket | null {
  if (!token) {
    console.warn("useSocket: токен пуст, WS не инициализирован");
    return null;
  }
  if (!socket) {
    socket = io(import.meta.env.VITE_API_URL || "http://localhost:3000", {
      auth: { token },
      transports: ["websocket"],
      autoConnect: true,
      reconnection: true,
    });

    // Логирование для отладки
    socket.on("connect", () => console.log("WS connected:", socket?.id));
    socket.on("disconnect", (reason) => console.log("WS disconnected:", reason));
    socket.on("connect_error", (err) => console.error("WS error:", err.message));
  }

  return socket;
}

/**
 * Получить текущий socket (если уже подключён)
 */
export function getSocket(): Socket | null {
  return socket;
}

/**
 * Отключиться от сервера (при logout)
 */
export function disconnectSocket() {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
}
