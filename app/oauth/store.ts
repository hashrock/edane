/**
 * OAuth の行の読み書き（D1）。ルートは {@link OAuthStore} 越しにしか触らないので、
 * テストはメモリ上の実装を渡せる。トークン・コード・シークレットはハッシュで渡される
 * （生の値はこのモジュールに来ない）。
 */
import { drizzle } from "drizzle-orm/d1";
import { and, desc, eq, gt, isNull, lt, lte } from "drizzle-orm";
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

/** 登録のついでに消す行の境目（epoch ms）。いつより前を消すかはルートが決める。 */
export interface PurgeCutoffs {
  /** これ以前に切れた認可コードと、リフレッシュトークンが切れた付与を消す。 */
  now: number;
  /** これより前に登録され、誰にも許可されていないクライアントを消す。 */
  unauthorizedClientsBefore: number;
}

export interface OAuthStore {
  /**
   * クライアントを登録し（`created_at` = `cutoffs.now`）、同じ batch でもう使えない行を消す:
   * 期限切れの認可コード、リフレッシュトークンが切れた付与、許可されないまま古くなったクライアント。
   * 登録は誰でもできるので、行が増えるここで片付ければ溜まらない。
   */
  createClient(client: OAuthClient, cutoffs: PurgeCutoffs): Promise<void>;
  findClient(id: string): Promise<OAuthClient | null>;
  saveCode(code: OAuthCode): Promise<void>;
  /** コードを消して返す（1 回だけ使える）。同時に 2 回交換されても片方にしか返らない。 */
  takeCode(codeHash: string): Promise<OAuthCode | null>;
  /** 付与を作り、クライアントを「許可されたことがある」にする（登録時の片付けで消えなくなる）。 */
  createGrant(grant: OAuthGrant, now: number): Promise<void>;
  /**
   * リフレッシュトークン（`clientId` のもの、`now` で未失効）を持つ付与のトークンを入れ替える。
   * 古いリフレッシュトークンは同時に無効になり、再利用の検知用に `previous_refresh_hash` に残る。
   * 該当なしなら null。
   */
  rotateGrant(refreshTokenHash: string, clientId: string, next: TokenPair, now: number): Promise<{ scope: string } | null>;
  /**
   * すでに入れ替えたリフレッシュトークンが再び使われた付与を消す（漏れたとみなす。OAuth 2.1 §4.3.1）。
   * 正規のクライアントと盗んだ側のどちらが先に使ったかは分からないので、付与ごと無効にする。消したら true。
   */
  revokeOnRefreshReuse(refreshTokenHash: string, clientId: string): Promise<boolean>;
  /** リフレッシュトークンが切れていない付与だけ（切れたものは再認可しないと使えない）。 */
  listGrants(userId: string, now: number): Promise<GrantSummary[]>;
  deleteGrant(userId: string, id: string): Promise<boolean>;
}

export function d1OAuthStore(env: Env["Bindings"]): OAuthStore {
  const db = drizzle(env.DB);
  return {
    async createClient(client, { now, unauthorizedClientsBefore }) {
      await db.batch([
        db.delete(oauthCodes).where(lte(oauthCodes.expiresAt, now)),
        db.delete(oauthGrants).where(lte(oauthGrants.refreshExpiresAt, now)),
        db
          .delete(oauthClients)
          .where(
            and(isNull(oauthClients.authorizedAt), lt(oauthClients.createdAt, new Date(unauthorizedClientsBefore).toISOString()))
          ),
        db.insert(oauthClients).values({
          id: client.id,
          name: client.name,
          redirectUris: JSON.stringify(client.redirectUris),
          secretHash: client.secretHash,
          createdAt: new Date(now).toISOString(),
        }),
      ]);
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
    async createGrant(grant, now) {
      await db.batch([
        db.insert(oauthGrants).values(grant),
        db
          .update(oauthClients)
          .set({ authorizedAt: now })
          .where(and(eq(oauthClients.id, grant.clientId), isNull(oauthClients.authorizedAt))),
      ]);
    },
    async rotateGrant(refreshTokenHash, clientId, next, now) {
      const rows = await db
        .update(oauthGrants)
        .set({ ...next, previousRefreshHash: refreshTokenHash })
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
    async revokeOnRefreshReuse(refreshTokenHash, clientId) {
      const rows = await db
        .delete(oauthGrants)
        .where(and(eq(oauthGrants.previousRefreshHash, refreshTokenHash), eq(oauthGrants.clientId, clientId)))
        .returning({ id: oauthGrants.id });
      return rows.length > 0;
    },
    async listGrants(userId, now) {
      return db
        .select({ id: oauthGrants.id, clientName: oauthClients.name, createdAt: oauthGrants.createdAt })
        .from(oauthGrants)
        .innerJoin(oauthClients, eq(oauthGrants.clientId, oauthClients.id))
        .where(and(eq(oauthGrants.userId, userId), gt(oauthGrants.refreshExpiresAt, now)))
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
