export interface SitesRuntimeClientConfig {
  readonly siteId: string;
  readonly baseUrl: string;
}
export interface SitesRuntimeEnvelope<T> {
  readonly ok: boolean;
  readonly data?: T;
  readonly error?: { readonly code: string; readonly message: string };
}
export class SitesRuntimeClient {
  constructor(
    private readonly config: SitesRuntimeClientConfig,
    private readonly fetcher: typeof fetch = fetch,
  ) {}
  readonly data = {
    create: <T>(collection: string, data: unknown) =>
      this.#request<T>(collection, { method: "POST", body: JSON.stringify(data) }),
    get: <T>(collection: string, id: string) =>
      this.#request<T>(`${collection}/${encodeURIComponent(id)}`),
    list: <T>(collection: string, query?: { limit?: number; offset?: number }) =>
      this.#request<T>(
        `${collection}?${new URLSearchParams(Object.entries(query ?? {}).map(([key, value]) => [key, String(value)]))}`,
      ),
    update: <T>(collection: string, id: string, data: unknown) =>
      this.#request<T>(`${collection}/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify(data),
      }),
    delete: (collection: string, id: string) =>
      this.#request<void>(`${collection}/${encodeURIComponent(id)}`, { method: "DELETE" }),
  };
  readonly auth = {
    signUp: <T>(email: string, password: string) =>
      this.#securityRequest<T>("auth/signup", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      }),
    login: <T>(email: string, password: string) =>
      this.#securityRequest<T>("auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      }),
    logout: () =>
      this.#securityRequest<{ loggedOut: boolean }>("auth/logout", { method: "POST", body: "{}" }),
    me: <T>() => this.#securityRequest<T>("auth/me"),
  };
  readonly actions = {
    execute: <T>(name: string, input: Readonly<Record<string, unknown>>) =>
      this.#securityRequest<T>(`actions/${encodeURIComponent(name)}`, {
        method: "POST",
        body: JSON.stringify(input),
      }),
  };
  async #request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.fetcher(
      `${this.config.baseUrl}/runtime/v1/sites/${encodeURIComponent(this.config.siteId)}/data/${path}`,
      {
        ...init,
        credentials: "include",
        headers: { "content-type": "application/json", ...init.headers },
      },
    );
    const envelope = (await response.json()) as SitesRuntimeEnvelope<T>;
    if (!response.ok || !envelope.ok)
      throw new Error(envelope.error?.message ?? `Sites Runtime HTTP ${response.status}`);
    return envelope.data as T;
  }
  async #securityRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.fetcher(
      `${this.config.baseUrl}/runtime/v1/sites/${encodeURIComponent(this.config.siteId)}/${path}`,
      {
        ...init,
        credentials: "include",
        headers: { "content-type": "application/json", ...init.headers },
      },
    );
    const envelope = (await response.json()) as SitesRuntimeEnvelope<T>;
    if (!response.ok || !envelope.ok)
      throw new Error(envelope.error?.message ?? `Sites Runtime HTTP ${response.status}`);
    return envelope.data as T;
  }
}

export type SitesAuthState<T> =
  | { readonly status: "loading" }
  | { readonly status: "authenticated"; readonly user: T }
  | { readonly status: "unauthenticated" };
export async function loadSitesAuthState<T>(
  client: SitesRuntimeClient,
): Promise<SitesAuthState<T>> {
  try {
    return { status: "authenticated", user: await client.auth.me<T>() };
  } catch {
    return { status: "unauthenticated" };
  }
}
export function requireSitesUser<T>(state: SitesAuthState<T>): T | undefined {
  return state.status === "authenticated" ? state.user : undefined;
}
