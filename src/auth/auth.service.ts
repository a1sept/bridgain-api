import { Injectable } from "@nestjs/common";
import { and, eq, isNull, gt } from "drizzle-orm";
import * as argon2 from "argon2";
import { DatabaseService } from "../db/database.service.js";
import { users, passwordCredentials, authSessions } from "../db/schema/auth.js";
import { AppKind, accountType, digest, fail, token } from "./security.js";
const hashOptions = {
  type: argon2.argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;
type Transaction = Parameters<
  Parameters<DatabaseService["db"]["transaction"]>[0]
>[0];
export const publicUser = (u: typeof users.$inferSelect) => ({
  id: u.id,
  email: u.email,
  displayName: u.displayName,
  accountType: u.accountType,
});
@Injectable()
export class AuthService {
  private readonly dummy = argon2.hash(token(), hashOptions);
  constructor(private readonly database: DatabaseService) {}
  private get db() {
    return this.database.db;
  }
  private async lock(tx: Transaction, id: string) {
    const [u] = await tx
      .select()
      .from(users)
      .where(eq(users.id, id))
      .for("update");
    return u;
  }
  origin(app: AppKind) {
    return new URL(
      process.env[
        app === "client" ? "CLIENT_APP_ORIGIN" : "DEVELOPER_APP_ORIGIN"
      ] ??
        (app === "client"
          ? "http://localhost:15173"
          : "http://localhost:15174"),
    ).origin;
  }
  async signup(
    app: AppKind,
    email: string,
    displayName: string,
    password: string,
  ) {
    const hash = await argon2.hash(password, hashOptions);
    await this.db.transaction(async (tx) => {
      const [u] = await tx
        .insert(users)
        .values({
          email,
          emailNormalized: email,
          displayName,
          accountType: accountType(app),
        })
        .onConflictDoNothing({ target: users.emailNormalized })
        .returning();
      if (!u)
        fail(409, "EMAIL_IN_USE", "이미 가입된 이메일입니다. 로그인해주세요.");
      await tx
        .insert(passwordCredentials)
        .values({ userId: u.id, passwordHash: hash });
    });
  }
  async login(
    app: AppKind,
    email: string,
    password: string,
    remember: boolean,
    oldToken?: string,
  ) {
    const [row] = await this.db
      .select({ u: users, c: passwordCredentials })
      .from(users)
      .innerJoin(passwordCredentials, eq(users.id, passwordCredentials.userId))
      .where(eq(users.emailNormalized, email));
    const valid = await argon2.verify(
      row?.c.passwordHash ?? (await this.dummy),
      password,
    );
    if (!row || !valid)
      fail(401, "INVALID_CREDENTIALS", "이메일 또는 비밀번호를 확인해주세요.");
    return this.db.transaction(async (tx) => {
      const u = await this.lock(tx, row.u.id);
      if (!u)
        fail(
          401,
          "INVALID_CREDENTIALS",
          "이메일 또는 비밀번호를 확인해주세요.",
        );
      const [c] = await tx
        .select()
        .from(passwordCredentials)
        .where(eq(passwordCredentials.userId, u.id));
      if (!c || c.passwordHash !== row.c.passwordHash)
        fail(
          401,
          "INVALID_CREDENTIALS",
          "이메일 또는 비밀번호를 확인해주세요.",
        );
      if (u.status !== "active")
        fail(403, "ACCOUNT_UNAVAILABLE", "사용할 수 없는 계정입니다.");
      if (u.accountType !== accountType(app))
        fail(
          403,
          "APP_MISMATCH",
          "가입한 계정 유형에 맞는 앱에서 로그인해주세요.",
        );
      if (oldToken)
        await tx
          .update(authSessions)
          .set({ revokedAt: new Date() })
          .where(
            and(
              eq(authSessions.tokenHash, digest(oldToken)),
              eq(authSessions.appKind, app),
            ),
          );
      const raw = token();
      const expiresAt = new Date(
        Date.now() + (remember ? 14 * 86400000 : 86400000),
      );
      await tx.insert(authSessions).values({
        userId: u.id,
        appKind: app,
        tokenHash: digest(raw),
        expiresAt,
      });
      return { raw, expiresAt, user: publicUser(u) };
    });
  }
  async me(app: AppKind, raw?: string) {
    if (!raw) fail(401, "UNAUTHENTICATED", "로그인이 필요합니다.");
    const [row] = await this.db
      .select({ u: users, s: authSessions })
      .from(authSessions)
      .innerJoin(users, eq(users.id, authSessions.userId))
      .where(
        and(
          eq(authSessions.tokenHash, digest(raw!)),
          eq(authSessions.appKind, app),
          isNull(authSessions.revokedAt),
          gt(authSessions.expiresAt, new Date()),
          eq(users.status, "active"),
          eq(users.accountType, accountType(app)),
        ),
      );
    if (!row) fail(401, "UNAUTHENTICATED", "로그인이 필요합니다.");
    await this.db
      .update(authSessions)
      .set({ lastSeenAt: new Date() })
      .where(eq(authSessions.id, row.s.id));
    return { user: publicUser(row.u) };
  }
  async logout(app: AppKind, raw?: string) {
    if (raw)
      await this.db
        .update(authSessions)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(authSessions.tokenHash, digest(raw)),
            eq(authSessions.appKind, app),
            isNull(authSessions.revokedAt),
          ),
        );
  }
}
