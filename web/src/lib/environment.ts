const normalizePublicUrl = (value: string | undefined, fallback: string): string =>
  value?.trim().replace(/\/$/, "") || fallback;

export const DEFAULT_SITES_DEV_API_URL = "http://127.0.0.1:4310";

export const sitesEnvironment = Object.freeze({
  apiUrl: normalizePublicUrl(process.env.NEXT_PUBLIC_SITES_API_URL, DEFAULT_SITES_DEV_API_URL),
  socketUrl: normalizePublicUrl(
    process.env.NEXT_PUBLIC_SITES_SOCKET_URL,
    process.env.NEXT_PUBLIC_SITES_API_URL?.trim() || DEFAULT_SITES_DEV_API_URL,
  ),
});
