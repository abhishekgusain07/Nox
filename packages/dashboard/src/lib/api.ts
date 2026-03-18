const SERVER_URL = process.env.NEXT_PUBLIC_SERVER_URL ?? "http://localhost:3000";

let currentApiKey: string | null = null;

export function setApiKey(key: string | null): void {
  currentApiKey = key;
  if (key) {
    if (typeof window !== "undefined") {
      localStorage.setItem("reload_api_key", key);
    }
  } else {
    if (typeof window !== "undefined") {
      localStorage.removeItem("reload_api_key");
    }
  }
}

export function getApiKey(): string | null {
  if (currentApiKey) return currentApiKey;
  if (typeof window !== "undefined") {
    const stored = localStorage.getItem("reload_api_key");
    if (stored) {
      currentApiKey = stored;
      return stored;
    }
  }
  return null;
}

export async function apiFetch(path: string, options?: RequestInit): Promise<Response> {
  const apiKey = getApiKey();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options?.headers as Record<string, string> ?? {}),
  };

  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  const res = await fetch(`${SERVER_URL}/api${path}`, {
    ...options,
    headers,
  });

  if (res.status === 401 && typeof window !== "undefined") {
    // API key invalid — clear it and redirect to login
    setApiKey(null);
    window.location.href = "/login";
  }

  return res;
}

export async function apiJson<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await apiFetch(path, options);
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}
