import { io, type Socket } from "socket.io-client";

let socket: Socket | null = null;
let lastGameId = "";

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
      // `lastGameId` нужен серверу, чтобы при КАЖДОМ (re)connect
      // сразу сделать `client.join("game:<id>")`. Без этого broadcast
      // через `server.to("game:...")` не доходит до только что
      // пересоединившегося сокета, и UI «зависает».
      query: { lastGameId },
      transports: ["websocket"],
      autoConnect: true,
      // автоматический reconnect с экспоненциальным backoff.
      reconnection: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
    });

    // Логирование для отладки
    socket.on("connect", () => console.log("WS connected:", socket?.id));
    socket.on("disconnect", (reason) => console.log("WS disconnected:", reason));
    socket.on("connect_error", (err) => console.error("WS error:", err.message));
    // Шлём «reconnect:request_state» при каждом восстановлении соединения —
    // сервер повторно отдаст state, чтобы клиент не «застрял» в устаревших данных.
    socket.on("reconnect", (attempt: number) => {
      console.log(`WS reconnected after ${attempt} attempts`);
      // GameStore подпишется на это событие в `connectAndJoin` и запросит state.
    });
  }

  return socket;
}

/**
 * Запомнить `gameId`, к которому мы сейчас подключены.
 * Передаётся серверу через `query.lastGameId` на каждом connect/reconnect.
 */
export function setLastGameId(id: string) {
  lastGameId = id;
  if (socket) {
    // socket.io-manager кэширует `query` на момент создания,
    // но при reconnect handshake использует актуальные query.
    // Меняем через io.opts.query и socket.io подхватит.
    (socket.io.opts.query as Record<string, string>).lastGameId = id;
  }
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
