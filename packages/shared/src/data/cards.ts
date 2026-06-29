export interface Card {
  id: string;
  deck: "chance" | "treasury";
  text: string;
  effect: CardEffect;
}

export type CardEffect =
  | { kind: "money"; amount: number }
  | { kind: "move"; target: number; money?: number }
  | { kind: "goto-jail" }
  | { kind: "jail-free" }
  | { kind: "move-relative"; steps: number };

export const CHANCE_CARDS: Card[] = [
  {
    id: "ch1",
    deck: "chance",
    text: "Отправляйтесь на Вперёд. Получите ₽200",
    effect: { kind: "move", target: 0, money: 200 },
  },
  {
    id: "ch2",
    deck: "chance",
    text: "Банк выплачивает вам дивиденды ₽50",
    effect: { kind: "money", amount: 50 },
  },
  {
    id: "ch3",
    deck: "chance",
    text: "Штраф за превышение скорости ₽15",
    effect: { kind: "money", amount: -15 },
  },
  {
    id: "ch4",
    deck: "chance",
    text: "Отправляйтесь в тюрьму",
    effect: { kind: "goto-jail" },
  },
  {
    id: "ch5",
    deck: "chance",
    text: "День рождения! Получите ₽50",
    effect: { kind: "money", amount: 50 },
  },
  {
    id: "ch6",
    deck: "chance",
    text: "Переместитесь на ул. Арбат",
    effect: { kind: "move", target: 37 },
  },
  {
    id: "ch7",
    deck: "chance",
    text: "Выйдите из тюрьмы бесплатно",
    effect: { kind: "jail-free" },
  },
  {
    id: "ch8",
    deck: "chance",
    text: "Вернитесь на 3 клетки назад",
    effect: { kind: "move-relative", steps: -3 },
  },
];

export const TREASURY_CARDS: Card[] = [
  {
    id: "tr1",
    deck: "treasury",
    text: "Наследство: получите ₽100",
    effect: { kind: "money", amount: 100 },
  },
  {
    id: "tr2",
    deck: "treasury",
    text: "Больничные расходы: заплатите ₽100",
    effect: { kind: "money", amount: -100 },
  },
  {
    id: "tr3",
    deck: "treasury",
    text: "Ошибка банка в вашу пользу: ₽200",
    effect: { kind: "money", amount: 200 },
  },
  {
    id: "tr4",
    deck: "treasury",
    text: "Отправляйтесь в тюрьму",
    effect: { kind: "goto-jail" },
  },
  {
    id: "tr5",
    deck: "treasury",
    text: "Бесплатная парковка",
    effect: { kind: "move", target: 20 },
  },
  {
    id: "tr6",
    deck: "treasury",
    text: "Школьные сборы: заплатите ₽50",
    effect: { kind: "money", amount: -50 },
  },
];

export function drawCard(deck: "chance" | "treasury"): Card {
  const cards = deck === "chance" ? CHANCE_CARDS : TREASURY_CARDS;
  return cards[Math.floor(Math.random() * cards.length)]!;
}
