import { defineStore } from "pinia";
import { ref } from "vue";
import axios from "axios";

const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL || "http://localhost:3000",
});

export const useAuthStore = defineStore("auth", () => {
  const token = ref(localStorage.getItem("token") || "");
  const refreshToken = ref(localStorage.getItem("refreshToken") || "");
  const userId = ref(localStorage.getItem("userId") || "");

  async function login(email: string, password: string) {
    const res = await api.post("/auth/login", { email, password });
    setTokens(res.data);
  }

  async function register(email: string, displayName: string, password: string) {
    const res = await api.post("/auth/register", {
      email,
      displayName,
      password,
    });
    setTokens(res.data);
  }

  async function loginAsGuest(name: string) {
    const res = await api.post("/auth/guest", { displayName: name });
    setTokens(res.data);
  }

  function setTokens(data: { accessToken: string; refreshToken: string; userId: string }) {
    token.value = data.accessToken;
    refreshToken.value = data.refreshToken;
    userId.value = data.userId;
    localStorage.setItem("token", data.accessToken);
    localStorage.setItem("refreshToken", data.refreshToken);
    localStorage.setItem("userId", data.userId);
  }

  function logout() {
    token.value = "";
    refreshToken.value = "";
    userId.value = "";
    localStorage.removeItem("token");
    localStorage.removeItem("refreshToken");
    localStorage.removeItem("userId");
  }

  return { token, refreshToken, userId, login, register, loginAsGuest, logout };
});
