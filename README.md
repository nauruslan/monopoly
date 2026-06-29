# Monopoly (online)

Клиент-серверная реализация Монополии на Vue 3 (Pinia, Vue Router) + планируемый NestJS-бэкенд.

## Структура репозитория

```
monopoly-monorepo/
├── apps/
│   ├── client/         Vue 3 + Vite + Pinia — игровой UI
│   └── server/         (заглушка) место под будущий NestJS-бэкенд
├── packages/
│   └── shared/         Общие TypeScript-типы и данные (доска, карточки)
├── package.json        Корневой манифест монорепо
├── pnpm-workspace.yaml Список workspace-пакетов
└── tsconfig.base.json  Общая база для TS-конфигов пакетов
```

## Команды

| Скрипт | Что делает |
|---|---|
| `pnpm dev` | Параллельно запускает `dev` во всех workspace-пакетах |
| `pnpm dev:client` | Только клиент (`http://localhost:5173`) |
| `pnpm dev:server` | Только сервер (заглушка) |
| `pnpm build` | Сборка всех пакетов |
| `pnpm typecheck` | Проверка типов во всех пакетах |
| `pnpm lint` / `lint:fix` | ESLint по всему монорепо |
| `pnpm format` / `format:check` | Prettier по всему монорепо |
| `pnpm infra:up` / `infra:down` | Docker Compose с PostgreSQL и Redis (Step 22+) |

## Установка

```bash
pnpm install