import { createRouter, createWebHistory } from "vue-router";

import LoginView from "../views/LoginView.vue";
import LobbyView from "../views/LobbyView.vue";
import GameView from "../views/GameView.vue";

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    { path: "/", name: "login", component: LoginView },
    { path: "/lobby", name: "lobby", component: LobbyView },
    { path: "/game/:id", name: "game", component: GameView, props: true },
  ],
});

export default router;
