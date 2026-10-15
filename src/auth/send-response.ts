import type { ServerResponse } from "node:http";

/**
 * GetChatly `sendResponse` (src/utils/sendResponse.js): `{ message, status }`
 * without data, `{ message, status, data }` with it. Only the authentication
 * middleware uses it; the Sites `{ error: { code, message } }` contract for
 * every other response is unchanged.
 */
export function sendResponse(
  res: ServerResponse,
  statusCode: number,
  message: string,
  status: boolean,
  data?: unknown,
): void {
  res.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data ? { message, status, data } : { message, status }));
}
