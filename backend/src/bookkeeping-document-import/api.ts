import { promises as fs } from "fs";
import { ImportFailure } from "./types";

export const PRODUCTION_ORIGIN = "https://ops.dtcdev.click";
type CookieFile = { origin: string; expiresAt: string; cookie: string };

export class BookkeepingApi {
  private constructor(
    readonly origin: string,
    private readonly authHeader: Record<string, string>,
    private readonly sleep: (milliseconds: number) => Promise<void>,
  ) {}

  static async create(input: {
    origin: string;
    cookieFile?: string;
    bearerToken?: string;
    allowTestOrigin?: boolean;
    sleep?: (milliseconds: number) => Promise<void>;
  }) {
    if (!input.allowTestOrigin && input.origin !== PRODUCTION_ORIGIN)
      throw new ImportFailure("invalid-api-origin");
    if (!!input.cookieFile === !!input.bearerToken)
      throw new ImportFailure("invalid-auth-mode");
    let authHeader: Record<string, string>;
    if (input.cookieFile) {
      const stat = await fs.lstat(input.cookieFile).catch(() => null);
      if (
        !stat?.isFile() ||
        stat.isSymbolicLink() ||
        (stat.mode & 0o077) !== 0 ||
        (typeof process.getuid === "function" && stat.uid !== process.getuid())
      )
        throw new ImportFailure("unsafe-cookie-file");
      let parsed: CookieFile;
      try {
        parsed = JSON.parse(await fs.readFile(input.cookieFile, "utf8"));
      } catch {
        throw new ImportFailure("invalid-cookie-file");
      }
      const expiresAt = Date.parse(parsed.expiresAt);
      if (
        parsed.origin !== input.origin ||
        !Number.isFinite(expiresAt) ||
        expiresAt <= Date.now() ||
        !/^[A-Za-z0-9._~-]{20,500}$/.test(parsed.cookie)
      )
        throw new ImportFailure("invalid-cookie-file");
      authHeader = { cookie: `dataops_session=${parsed.cookie}` };
    } else {
      const token = input.bearerToken || "";
      if (!/^[A-Za-z0-9._~-]{20,500}$/.test(token) || token.startsWith("eyJ"))
        throw new ImportFailure("invalid-bearer-session");
      authHeader = { authorization: `Bearer ${token}` };
    }
    return new BookkeepingApi(
      input.origin,
      authHeader,
      input.sleep || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))),
    );
  }

  async request<T>(method: "GET" | "POST" | "PUT", path: string, body?: unknown) {
    for (let attempt = 0; attempt < 3; attempt++) {
      let response: Response;
      try {
        response = await fetch(`${this.origin}${path}`, {
          method,
          redirect: "manual",
          headers: {
            ...this.authHeader,
            accept: "application/json",
            ...(body === undefined ? {} : { "content-type": "application/json" }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch {
        if (attempt < 2) {
          await this.sleep(100 * 2 ** attempt);
          continue;
        }
        throw new ImportFailure("api-transient-failure");
      }
      if (response.status >= 300 && response.status < 400)
        throw new ImportFailure("unexpected-api-redirect");
      if ((response.status === 429 || response.status >= 500) && attempt < 2) {
        const retryAfter = Number(response.headers.get("retry-after") || 0);
        await this.sleep(Math.min(2_000, Math.max(100 * 2 ** attempt, retryAfter * 1000)));
        continue;
      }
      const contentType = response.headers.get("content-type") || "";
      if (!contentType.toLowerCase().includes("application/json"))
        throw new ImportFailure("unexpected-api-response");
      const result = (await response.json()) as T;
      if (!response.ok)
        throw new ImportFailure(
          response.status === 401 || response.status === 403
            ? "operator-auth-rejected"
            : response.status === 429 || response.status >= 500
              ? "api-transient-failure"
              : "api-request-rejected",
        );
      return result;
    }
    throw new ImportFailure("api-transient-failure");
  }

  async preflight() {
    const result = await this.request<{ user?: { enabled?: boolean } }>("GET", "/api/me");
    if (!result.user || result.user.enabled === false)
      throw new ImportFailure("operator-auth-rejected");
  }

  async upload(
    url: string,
    headers: Record<string, string>,
    openStream: () => Promise<{ stream: NodeJS.ReadableStream; close: () => void }>,
  ) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const opened = await openStream();
      let response: Response;
      try {
        response = await fetch(url, {
          method: "PUT",
          redirect: "manual",
          headers,
          body: opened.stream as unknown as BodyInit,
          // Node requires duplex for a streaming request body.
          duplex: "half",
        } as RequestInit & { duplex: "half" });
      } catch {
        if (attempt === 2) throw new ImportFailure("upload-transient-failure");
        await this.sleep(100 * 2 ** attempt);
        continue;
      } finally {
        opened.close();
      }
      if (response.status === 412) return "already-present" as const;
      if (response.ok) return "uploaded" as const;
      if (response.status !== 429 && response.status < 500)
        throw new ImportFailure("upload-rejected");
      if (attempt === 2) throw new ImportFailure("upload-transient-failure");
      const retryAfter = response.headers.get("retry-after");
      const seconds = retryAfter === null ? NaN : Number(retryAfter);
      const dateDelay = retryAfter && !Number.isFinite(seconds)
        ? Math.max(0, Date.parse(retryAfter) - Date.now())
        : 0;
      const retryDelay = Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : dateDelay;
      await this.sleep(Math.min(2_000, Math.max(100 * 2 ** attempt, retryDelay)));
    }
    throw new ImportFailure("upload-transient-failure");
  }
}
