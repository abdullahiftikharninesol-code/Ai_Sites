import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";

/** Connect to the address already validated by the gateway, preserving Host/TLS name. */
export function pinnedRequest(url: URL, address: string, init: RequestInit): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = (url.protocol === "https:" ? httpsRequest : httpRequest)(
      url,
      {
        method: init.method ?? "GET",
        headers: Object.fromEntries(new Headers(init.headers)),
        ...(init.signal ? { signal: init.signal } : {}),
        lookup: (_hostname, options, callback) => {
          if (options.all) callback(null, [{ address, family: isIP(address) }]);
          else callback(null, address, isIP(address));
        },
      },
      (res) => {
        const headers = new Headers();
        for (const [key, value] of Object.entries(res.headers)) {
          if (Array.isArray(value)) for (const item of value) headers.append(key, item);
          else if (value !== undefined) headers.set(key, value);
        }
        const status = res.statusCode ?? 502;
        if ([204, 205, 304].includes(status)) res.resume();
        resolve(
          new Response(
            [204, 205, 304].includes(status)
              ? null
              : (Readable.toWeb(res) as ReadableStream<Uint8Array>),
            { status, headers },
          ),
        );
      },
    );
    req.once("error", reject);
    req.end(typeof init.body === "string" ? init.body : undefined);
  });
}
