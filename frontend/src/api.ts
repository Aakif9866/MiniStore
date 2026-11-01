// Thin client for the MiniStore API. In dev, Vite proxies /api → backend (see vite.config.ts).
const BASE = "/api";
const TOKEN_KEY = "ministore.token";

export type FileDto = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  etag: string | null;
  versionId: string | null;
  createdAt: string;
  updatedAt: string;
};

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

// ponytail: token in localStorage is readable by any XSS on this origin; move to an
// httpOnly cookie when the backend issues one (Phase 14 security pass).
export const getToken = () => localStorage.getItem(TOKEN_KEY);
export function setToken(token: string | null) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
  window.dispatchEvent(new Event("auth-change"));
}

function authHeader(): Record<string, string> {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** Turn a non-2xx response into an ApiError. An expired session logs the user out. */
async function fail(res: Response): Promise<never> {
  const body = await res.json().catch(() => ({}));
  if (res.status === 401 && getToken()) setToken(null);
  const firstDetail = body.details && Object.values(body.details).flat()[0];
  throw new ApiError(res.status, firstDetail ? `${body.error}: ${firstDetail}` : body.error ?? res.statusText);
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(BASE + path, { ...init, headers: { ...authHeader(), ...init.headers } });
  if (!res.ok) await fail(res);
  return res.status === 204 ? (undefined as T) : res.json();
}

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

export const api = {
  register: (email: string, password: string) =>
    request<{ id: string; email: string }>("/auth/register", json({ email, password })),

  login: (email: string, password: string) =>
    request<{ token: string }>("/auth/login", json({ email, password })),

  listFiles: () => request<FileDto[]>("/files"),

  usage: () => request<{ usedBytes: number; quotaBytes: number; fileCount: number }>("/files/usage"),

  deleteFile: (id: string) => request<void>(`/files/${id}`, { method: "DELETE" }),

  /** XHR instead of fetch: fetch still can't report upload progress. */
  upload(file: File, onProgress: (fraction: number) => void): Promise<FileDto> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `${BASE}/files/upload`);
      for (const [k, v] of Object.entries(authHeader())) xhr.setRequestHeader(k, v);
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
      xhr.onload = () => {
        if (xhr.status === 201) return resolve(JSON.parse(xhr.responseText));
        fail(new Response(xhr.responseText, { status: xhr.status })).catch(reject);
      };
      xhr.onerror = () => reject(new ApiError(0, "Network error"));
      const form = new FormData();
      form.append("file", file);
      xhr.send(form);
    });
  },

  /**
   * Ask the API for a short-lived presigned URL, then let the browser fetch it from MinIO directly.
   * MinIO answers with Content-Disposition: attachment, so the page stays put and a download starts.
   */
  async download(file: FileDto) {
    const { url } = await request<{ url: string }>(`/files/${file.id}/download-url`);
    window.location.assign(url);
  },
};
