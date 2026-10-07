import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  Res,
} from "@nestjs/common";
import type { Request, Response, CookieOptions } from "express";
import { AuthService } from "./auth.service.js";
import {
  AppKind,
  cookies,
  email,
  equal,
  fail,
  password,
  token,
  digest,
} from "./security.js";
@Controller("auth")
export class AuthController {
  private readonly attempts = new Map<
    string,
    {
      count: number;
      until: number;
    }
  >();
  constructor(private readonly auth: AuthService) {}
  private app(req: Request): AppKind {
    const secret = process.env.AUTH_PROXY_SECRET;
    if (
      !secret ||
      secret.length < 32 ||
      !equal(req.get("x-bridgain-proxy-secret") ?? "", secret)
    )
      fail(403, "PROXY_REQUIRED", "허용된 앱을 통해 접속해주세요.");
    const app = req.get("x-bridgain-app");
    if (app !== "client" && app !== "developer")
      fail(403, "PROXY_REQUIRED", "허용된 앱을 통해 접속해주세요.");
    return app as AppKind;
  }
  private name(app: AppKind, kind = "session") {
    return `bridgain_${app}_${kind}`;
  }
  private options(): CookieOptions {
    return {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
    };
  }
  private session(req: Request, app: AppKind) {
    return cookies(req.get("cookie"))[this.name(app)];
  }
  private mutation(req: Request, res: Response, key: string, limit = 10) {
    const app = this.app(req);
    const origin = req.get("origin");
    const csrf = cookies(req.get("cookie"))[this.name(app, "csrf")];
    if (
      origin !== this.auth.origin(app) ||
      !csrf ||
      !/^[a-f0-9]{64}$/.test(csrf) ||
      !equal(csrf, req.get("x-csrf-token") ?? "")
    )
      fail(
        403,
        "CSRF_INVALID",
        "보안 확인이 만료되었습니다. 새로고침 후 다시 시도해주세요.",
      );
    // Proxy overwrites x-bridgain-client-ip; never trust client-provided X-Forwarded-For.
    this.limit(
      `${app}:ip:${req.get("x-bridgain-client-ip") ?? req.socket.remoteAddress}:${key}`,
      limit * 5,
      res,
    );
    const identity =
      typeof req.body?.email === "string"
        ? req.body.email.trim().toLowerCase()
        : typeof req.body?.token === "string"
          ? req.body.token
          : undefined;
    if (identity)
      this.limit(`${app}:identity:${digest(identity)}:${key}`, limit, res);
    return app;
  }
  private limit(key: string, max: number, res: Response) {
    const now = Date.now();
    for (const [k, v] of this.attempts)
      if (v.until <= now) this.attempts.delete(k);
    if (this.attempts.size >= 10000 && !this.attempts.has(key)) {
      res.setHeader("Retry-After", "60");
      fail(429, "RATE_LIMITED", "잠시 후 다시 시도해주세요.");
    }
    const v = this.attempts.get(key) ?? { count: 0, until: now + 900000 };
    v.count++;
    this.attempts.set(key, v);
    if (v.count > max) {
      res.setHeader("Retry-After", String(Math.ceil((v.until - now) / 1000)));
      fail(429, "RATE_LIMITED", "요청이 많습니다. 잠시 후 다시 시도해주세요.");
    }
  }
  @Get("csrf")
  csrf(
    @Req()
    req: Request,
    @Res({ passthrough: true })
    res: Response,
  ) {
    const app = this.app(req);
    const previous = cookies(req.get("cookie"))[this.name(app, "csrf")];
    const csrfToken =
      previous && /^[a-f0-9]{64}$/.test(previous) ? previous : token();
    res.setHeader("Cache-Control", "no-store");
    res.cookie(this.name(app, "csrf"), csrfToken, this.options());
    return { csrfToken };
  }
  @Post("signup")
  @HttpCode(201)
  async signup(
    @Req()
    req: Request,
    @Res({ passthrough: true })
    res: Response,
    @Body()
    body: Record<string, unknown>,
  ) {
    const app = this.mutation(req, res, "signup", 5);
    const mail = email(body?.email);
    const pw = password(body?.password);
    const name =
      typeof body?.displayName === "string" ? body.displayName.trim() : "";
    if (!name || name.length > 80)
      fail(400, "VALIDATION_ERROR", "이름은 1~80자로 입력해주세요.");
    await this.auth.signup(app, mail, name, pw);
    return { message: "가입이 완료되었습니다. 로그인해주세요." };
  }
  @Post("login")
  @HttpCode(200)
  async login(
    @Req()
    req: Request,
    @Res({ passthrough: true })
    res: Response,
    @Body()
    body: Record<string, unknown>,
  ) {
    const app = this.mutation(req, res, "login");
    const mail = email(body?.email);
    if (
      typeof body?.password !== "string" ||
      body.password.length > 128 ||
      body.password.length === 0
    )
      fail(400, "VALIDATION_ERROR", "비밀번호를 입력해주세요.");
    if (body.rememberMe !== undefined && typeof body.rememberMe !== "boolean")
      fail(400, "VALIDATION_ERROR", "로그인 유지 값을 확인해주세요.");
    const result = await this.auth.login(
      app,
      mail,
      body.password as string,
      body.rememberMe === true,
      this.session(req, app),
    );
    res.cookie(this.name(app), result.raw, {
      ...this.options(),
      ...(body.rememberMe ? { expires: result.expiresAt } : {}),
    });
    res.setHeader("Cache-Control", "no-store");
    return { user: result.user };
  }
  @Get("me")
  async me(
    @Req()
    req: Request,
    @Res({ passthrough: true })
    res: Response,
  ) {
    const app = this.app(req);
    res.setHeader("Cache-Control", "no-store");
    return this.auth.me(app, this.session(req, app));
  }
  @Post("logout")
  @HttpCode(204)
  async logout(
    @Req()
    req: Request,
    @Res({ passthrough: true })
    res: Response,
  ) {
    const app = this.mutation(req, res, "logout", 30);
    await this.auth.logout(app, this.session(req, app));
    res.clearCookie(this.name(app), this.options());
  }
}
