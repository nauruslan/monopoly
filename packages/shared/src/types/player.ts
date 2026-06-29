// PlayerKind — тип игрока
// human — реальный человек (управляется через UI)
// bot — компьютерный противник (управляется через AI)
// guest — без регистрации
export type PlayerKind = "human" | "bot" | "guest";

// Player — основной интерфейс игрока
export interface Player {
  // Уникальный ID (uuid, генерируем на сервере)
  id: string;

  // Имя для отображения
  displayName: string;

  // Тип игрока (из PlayerKind)
  kind: PlayerKind;

  // HEX-цвет фишки
  // Используется для подсветки и идентификации на доске
  color: string;

  // Иконка
  icon: string;

  // Текущий баланс в рублях
  money: number;

  // Позиция на доске (0-39)
  position: number;

  // Находится ли в тюрьме
  inJail: boolean;

  // Сколько ходов уже сидит в тюрьме (0-3)
  // После 3 ходов — вынужден заплатить 50₽
  jailTurns: number;

  // Сколько карточек "выйди из тюрьмы бесплатно" у игрока
  jailCards: number;

  // Массив ID клеток, принадлежащих игроку
  properties: number[];

  // Обанкротился ли игрок
  // После банкротства удаляется из ротации
  isBankrupt: boolean;
}
