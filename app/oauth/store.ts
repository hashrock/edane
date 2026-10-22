/**
 * OAuth の行の読み書き（D1）。ルートは {@link OAuthStore} 越しにしか触らないので、
 * テストはメモリ上の実装を渡せる。トークン・コード・シークレットはハッシュで渡される
 * （生の値はこのモジュールに来ない）。
 */
import { drizzle } from "drizzle-orm/d1";
import { and, desc, eq, gt } from "drizzle-orm";
import type { Env } from "../global.d";
import { oauthClients, oauthCodes, oauthGrants } from "../db/schema";

export interface OAuthClient {
  id: string;
  name: string;
  redirectUris: string[];
  /** null = 公開クライアント。 */
  secretHash: string | null;
}

export interface OAuthCode {
  codeHash: string;
  clientId: string;
  userId: string;
  redirectUri: string;
  codeChallenge: string;
  scope: string;
  expiresAt: number;
}

export interface TokenPair {
  accessTokenHash: string;
  accessExpiresAt: number;
  refreshTokenHash: string;
  refreshExpiresAt: number;
}

export interface OAuthGrant extends TokenPair {
  id: string;
  clientId: string;
  userId: string;
  scope: string;
}

export interface GrantSummary {
  id: string;
  clientName: string;
  createdAt: string;
}

export interface OAuthStore {
  createClient(client: OAuthClient): Promise<void>;
  findClient(id: string): Promise<OAuthClient | null>;
  saveCode(code: OAuthCode): Promise<void>;
  /** コードを消して返す（1 回だけ使える）。同時に 2 回交換されても片方にしか返らない。 */
  takeCode(codeHash: string): Promise<OAuthCode | null>;
  createGrant(grant: OAuthGrant): Promise<void>;
  /**
   * リフレッシュトークン（`clientId` のもの、`now` で未失効）を持つ付与のトークンを入れ替える。
   * 古いリフレッシュトークンは同時に無効になる。該当なしなら null。
   */
  rotateGrant(refreshTokenHash: string, clientId: string, next: TokenPair, now: number): Promise<{ scope: string } | null>;
  listGrants(userId: string): Promise<GrantSummary[]>;
  deleteGrant(userId: string, id: string): Promise<boolean>;
}

export function d1OAuthStore(env: Env["Bindings"]): OAuthStore {
  const db = drizzle(env.DB);
  return {
    async createClient(client) {
      await db.insert(oauthClients).values({
        id: client.id,
        name: client.name,
        redirectUris: JSON.stringify(client.redirectUris),
        secretHash: client.secretHash,
        createdAt: new Date().toISOString(),
      });
    },
    async findClient(id) {
      const row = await db.select().from(oauthClients).where(eq(oauthClients.id, id)).get();
      if (!row) return null;
      return { id: row.id, name: row.name, redirectUris: JSON.parse(row.redirectUris) as string[], secretHash: row.secretHash };
    },
    async saveCode(code) {
      await db.insert(oauthCodes).values(code);
    },
    async takeCode(codeHash) {
      const rows = await db.delete(oauthCodes).where(eq(oauthCodes.codeHash, codeHash)).returning();
      return rows[0] ?? null;
    },
    async createGrant(grant) {
      await db.insert(oauthGrants).values({ ...grant, createdAt: new Date().toISOString() });
    },
    async rotateGrant(refreshTokenHash, clientId, next, now) {
      const rows = await db
        .update(oauthGrants)
        .set(next)
        .where(
          and(
            eq(oauthGrants.refreshTokenHash, refreshTokenHash),
            eq(oauthGrants.clientId, clientId),
            gt(oauthGrants.refreshExpiresAt, now)
          )
        )
        .returning({ scope: oauthGrants.scope });
      return rows[0] ?? null;
    },
    async listGrants(userId) {
      return db
        .select({ id: oauthGrants.id, clientName: oauthClients.name, createdAt: oauthGrants.createdAt })
        .from(oauthGrants)
        .innerJoin(oauthClients, eq(oauthGrants.clientId, oauthClients.id))
        .where(eq(oauthGrants.userId, userId))
        .orderBy(desc(oauthGrants.createdAt));
    },
    async deleteGrant(userId, id) {
      const rows = await db
        .delete(oauthGrants)
        .where(and(eq(oauthGrants.id, id), eq(oauthGrants.userId, userId)))
        .returning({ id: oauthGrants.id });
      return rows.length > 0;
    },
  };
}
