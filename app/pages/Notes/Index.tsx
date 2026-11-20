import { Head, Link, router } from "@inertiajs/react";
import { useEffect, useMemo, useRef, useState } from "react";
import ContextMenu from "../../components/ContextMenu";
import {
  GlobeIcon,
  HistoryIcon,
  LinkIcon,
  MoreVerticalIcon,
  PencilIcon,
  PinIcon,
  SearchIcon,
  TrashIcon,
} from "../../components/icons";
import { takePendingNote } from "../../application/guestNote";
import {
  copyLinkFailure,
  copyLinkSuccess,
  privateNoteCopyReason,
  publicNoteUrl,
} from "../../application/publicNoteLink";
import { dateLocale, t } from "../../application/i18n";
import { useLocale } from "../../components/useLocale";
import { copyText } from "../../lib/clipboard";
import type { SessionUser } from "../../user";
import ServiceSwitcher from "../../components/ServiceSwitcher";

/** コピー結果を出しておく時間（ms）。 */
const FLASH_MS = 2500;
/** リストの出現アニメーションの遅延上限（件数が多くても下部の表示が遅れ続けないようにする）。 */
const MAX_STAGGER_INDEX = 8;
const STAGGER_STEP_MS = 30;

type Note = {
  id: string;
  title: string;
  isPublic: boolean;
  pinned: boolean;
  updatedAt: string;
};

type User = SessionUser | null;

function formatNoteDate(iso: string, locale: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(locale);
}

function formatNoteDateTime(iso: string, locale: string): string {
  const d = new Date(iso);
  return d.toLocaleString(locale);
}

export default function NotesIndex({
  user,
  notes,
}: {
  user: User;
  notes: Note[];
}) {
  useLocale(); // 言語切り替えで再レンダー（t() / 日付表記の購読）
  const [menu, setMenu] = useState<{ note: Note; x: number; y: number } | null>(
    null
  );
  const [importing, setImporting] = useState(false);
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState("");
  // コピー結果の一言。エディタのヘッダー（saveStatus）と同じ「見出し行に小さく
  // 出して勝手に消える」パターンに揃えている（専用のトースト機構は持たない）。
  // 同じ文言を連続で出しても表示時間を測り直せるよう、毎回別オブジェクトにする。
  const [flash, setFlash] = useState<{ seq: number; text: string } | null>(null);
  const flashSeq = useRef(0);

  // Client-side title search over the already-loaded list (no API needed).
  const trimmedQuery = query.trim();
  const filtered = useMemo(() => {
    const q = trimmedQuery.toLowerCase();
    if (!q) return notes;
    return notes.filter((n) => (n.title || "").toLowerCase().includes(q));
  }, [notes, trimmedQuery]);

  // ピン留めと通常が両方あるときだけセクション見出しで境界を明示する。
  const { pinnedNotes, otherNotes } = useMemo(() => {
    const pinned: Note[] = [];
    const others: Note[] = [];
    for (const n of filtered) {
      if (n.pinned) pinned.push(n);
      else others.push(n);
    }
    return { pinnedNotes: pinned, otherNotes: others };
  }, [filtered]);
  const showSectionHeaders = pinnedNotes.length > 0 && otherNotes.length > 0;

  // 新規作成画面は挟まない。仮のタイトル・非公開でその場で作って、そのまま
  // エディタへ送る（タイトルも公開設定もエディタのヘッダーで変えられる）。
  const createNote = () => {
    setCreating(true);
    router.post(
      "/notes",
      { title: t("untitled"), content: t("starterTopics") },
      { onError: () => setCreating(false) }
    );
  };

  const togglePin = (note: Note) => {
    router.post(
      `/notes/${note.id}/pin`,
      { pinned: !note.pinned },
      { preserveScroll: true }
    );
  };

  const trashNote = (note: Note) => {
    router.post(`/notes/${note.id}/trash`, {}, { preserveScroll: true });
  };

  const copyLink = (note: Note) => {
    void copyText(publicNoteUrl(window.location.origin, note.id)).then((ok) =>
      setFlash({
        seq: ++flashSeq.current,
        text: ok ? copyLinkSuccess() : copyLinkFailure(),
      })
    );
  };

  // 出しっぱなしにせず自動で消す。
  useEffect(() => {
    if (!flash) return;
    const timer = setTimeout(() => setFlash(null), FLASH_MS);
    return () => clearTimeout(timer);
  }, [flash]);

  const openMenu = (note: Note, e: React.MouseEvent<HTMLButtonElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    setMenu({ note, x: r.right, y: r.bottom + 4 });
  };

  // Just signed in with a stashed guest note? Import it into a real note and
  // jump straight to its editor. Consume-once, so a reload won't re-import.
  useEffect(() => {
    if (!user) return;
    const pending = takePendingNote();
    if (!pending) return;
    setImporting(true);
    router.post(
      "/notes",
      { title: pending.title, content: pending.content },
      { onError: () => setImporting(false) }
    );
  }, [user]);

  const locale = dateLocale();

  const renderStatusBadge = (isPublic: boolean) =>
    isPublic ? (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-medium text-emerald-700 ring-1 ring-inset ring-emerald-600/15">
        <GlobeIcon width="12" height="12" className="shrink-0" />
        {t("publicLabel")}
      </span>
    ) : (
      <span className="text-xs text-slate-400">{t("privateLabel")}</span>
    );

  const renderNoteRow = (note: Note, index: number, showTopBorder: boolean) => {
    const hasTitle = note.title.trim().length > 0;
    const delayMs = Math.min(index, MAX_STAGGER_INDEX) * STAGGER_STEP_MS;
    return (
      <div
        key={note.id}
        style={{ animationDelay: `${delayMs}ms` }}
        className={`anim-item group flex items-center transition-colors hover:bg-slate-50 ${
          showTopBorder ? "border-t border-slate-100" : ""
        }`}
      >
        <Link
          href={`/notes/${note.id}/edit`}
          className="flex-1 min-w-0 px-4 py-3.5 sm:px-5 sm:py-4 focus-visible:outline-none focus-visible:bg-slate-50"
        >
          <div className="flex items-center gap-1.5 text-[15px] leading-snug">
            {note.pinned && (
              <PinIcon
                width="14"
                height="14"
                className="shrink-0 text-emerald-600"
              />
            )}
            <span
              className={`truncate ${
                hasTitle
                  ? "font-semibold text-slate-950"
                  : "font-normal text-slate-400"
              }`}
            >
              {hasTitle ? note.title : t("untitled")}
            </span>
          </div>
          <div className="mt-1 flex items-center gap-2 text-xs text-slate-500">
            <time
              dateTime={note.updatedAt}
              title={formatNoteDateTime(note.updatedAt, locale)}
            >
              {formatNoteDate(note.updatedAt, locale)}
            </time>
            {/* モバイルでは公開状態を2行目に寄せてタイトル領域を広く確保する */}
            <span className="sm:hidden text-slate-300" aria-hidden="true">
              ·
            </span>
            <span className="sm:hidden">{renderStatusBadge(note.isPublic)}</span>
          </div>
        </Link>
        <div className="flex shrink-0 items-center gap-3 pr-2.5 pl-1 sm:pr-4 sm:pl-2">
          <div className="hidden sm:flex items-center">
            {renderStatusBadge(note.isPublic)}
          </div>
          <button
            type="button"
            onClick={(e) => openMenu(note, e)}
            className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-lg text-slate-400 opacity-80 transition hover:bg-slate-100 hover:text-slate-700 group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
            title={t("menu")}
            aria-label={t("menu")}
          >
            <MoreVerticalIcon />
          </button>
        </div>
      </div>
    );
  };

  return (
    <div
      className={`mx-auto px-4 py-6 sm:px-6 sm:py-7 md:py-9 ${user ? "max-w-3xl" : "max-w-5xl"}`}
    >
      <Head title="Edane" />
      {/* サービス切り替えは常にヘッダ右上の角に置く。狭い画面ではナビを 2 段目に回し、
          切り替えはロゴと同じ 1 段目の右端に残す（order で並べ替える） */}
      <header className="anim-header flex flex-wrap items-center gap-x-3 gap-y-2 mb-8 sm:mb-10">
        <h1 className="text-xl font-bold tracking-tight">
          <Link
            href={user ? "/notes" : "/"}
            className="inline-flex items-center rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
          >
            <img src="/logo.svg" alt="Edane" className="h-7 w-auto" />
          </Link>
        </h1>
        <div className="order-3 w-full flex items-center gap-2 sm:gap-3 flex-wrap sm:order-2 sm:w-auto sm:ml-auto">
          {user ? (
            <div className="flex items-center gap-3 text-sm text-slate-700">
              {user.avatarUrl && (
                <img
                  src={user.avatarUrl}
                  alt=""
                  className="w-7 h-7 rounded-full"
                />
              )}
              <span className="font-medium text-slate-700">{user.name}</span>
              <Link
                href="/trash"
                className="rounded-md px-1 py-1 text-slate-500 hover:text-slate-900 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
              >
                {t("trash")}
              </Link>
              <Link
                href="/settings"
                className="rounded-md px-1 py-1 text-slate-500 hover:text-slate-900 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
              >
                {t("settingsNav")}
              </Link>
              {/* POST so another site can't sign the user out with a link. */}
              <form method="post" action="/auth/logout" className="contents">
                <button
                  type="submit"
                  className="cursor-pointer rounded-md px-1 py-1 text-slate-500 hover:text-slate-900 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
                >
                  {t("logout")}
                </button>
              </form>
            </div>
          ) : (
            <a
              href="/auth/google"
              className="rounded-md px-1 py-1 text-sm font-medium text-slate-900 hover:text-slate-600 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
            >
              {t("loginWithGoogle")}
            </a>
          )}
        </div>
        {/* ログアウトと押し間違えないよう少し離す */}
        <ServiceSwitcher className="order-2 ml-auto sm:order-3 sm:ml-2 text-slate-500 hover:text-slate-900" />
      </header>

      {!user && (
        <section className="anim-item">
          <div className="mb-4">
            <h2 className="text-lg font-bold tracking-tight text-slate-900">
              {t("landingTitle")}
            </h2>
            <p className="mt-1 text-sm text-slate-500">
              {t("landingSubtitle")}
            </p>
          </div>
          <div
            className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm"
            style={{ height: "70vh" }}
          >
            <iframe
              src="/guest?embed=1"
              title={t("guestEditorTitle")}
              className="h-full w-full border-0"
            />
          </div>
        </section>
      )}

      {user && (
        <section>
          <div className="flex items-center justify-between gap-3 mb-5">
            <h2 className="text-xl font-bold tracking-tight text-slate-900">
              {t("myNotes")}
            </h2>
            <div className="flex items-center gap-3">
              {flash && (
                <span
                  role="status"
                  className="whitespace-nowrap text-xs text-slate-500"
                >
                  {flash.text}
                </span>
              )}
              <button
                type="button"
                onClick={createNote}
                disabled={creating}
                className="cursor-pointer rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-emerald-700 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {creating ? t("creating") : t("newNoteButton")}
              </button>
            </div>
          </div>
          {notes.length > 0 && (
            <div className="mb-4">
              <div className="relative">
                <SearchIcon
                  width="16"
                  height="16"
                  className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400"
                />
                <input
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={t("searchByTitle")}
                  aria-label={t("searchByTitle")}
                  className="w-full rounded-xl border border-slate-200 bg-white py-2.5 pl-10 pr-4 text-sm text-slate-900 placeholder:text-slate-400 outline-none transition focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100"
                />
              </div>
              {trimmedQuery && (
                <div className="mt-2 flex items-center justify-between px-1 text-xs text-slate-500">
                  <span>
                    {t("searchResultCount", {
                      count: String(filtered.length),
                      total: String(notes.length),
                    })}
                  </span>
                </div>
              )}
            </div>
          )}
          {notes.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-slate-200 bg-white px-6 py-12 text-center">
              <p className="text-sm text-slate-500">{t("noNotes")}</p>
              <button
                type="button"
                onClick={createNote}
                disabled={creating}
                className="mt-4 cursor-pointer rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-emerald-700 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {creating ? t("creating") : t("newNoteButton")}
              </button>
            </div>
          ) : filtered.length === 0 ? (
            <div className="rounded-2xl border border-slate-200 bg-white px-6 py-10 text-center shadow-sm">
              <p className="text-sm text-slate-500">
                {t("noNotesMatch", { query })}
              </p>
              <button
                type="button"
                onClick={() => setQuery("")}
                className="mt-3 cursor-pointer rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
              >
                {t("clearSearch")}
              </button>
            </div>
          ) : (
            <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
              {showSectionHeaders ? (
                <>
                  <div className="border-b border-slate-100 bg-slate-50/70 px-4 py-1.5 text-xs font-medium text-slate-500 sm:px-5">
                    {t("pinnedSection")}
                  </div>
                  {pinnedNotes.map((note, index) =>
                    renderNoteRow(note, index, index !== 0)
                  )}
                  <div className="border-y border-slate-100 bg-slate-50/70 px-4 py-1.5 text-xs font-medium text-slate-500 sm:px-5">
                    {t("otherNotesSection")}
                  </div>
                  {otherNotes.map((note, index) =>
                    renderNoteRow(
                      note,
                      pinnedNotes.length + index,
                      index !== 0
                    )
                  )}
                </>
              ) : (
                filtered.map((note, index) =>
                  renderNoteRow(note, index, index !== 0)
                )
              )}
            </div>
          )}
        </section>
      )}

      {importing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-white/70 backdrop-blur-sm">
          <p className="text-sm font-medium text-slate-600">
            {t("savingNote")}
          </p>
        </div>
      )}

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          align="right"
          onClose={() => setMenu(null)}
          items={[
            {
              label: t("menuEditNote"),
              icon: <PencilIcon />,
              onSelect: () => router.visit(`/notes/${menu.note.id}/edit`),
            },
            { separator: true },
            {
              label: t("copyLinkLabel"),
              icon: <LinkIcon />,
              // 非公開でも項目は残して理由を見せる（privateNoteCopyReason の
              // コメント参照）。
              disabled: !menu.note.isPublic,
              disabledReason: privateNoteCopyReason(),
              onSelect: () => copyLink(menu.note),
            },
            {
              // 公開した相手にどう見えるかを自分で確かめる導線（usertest #6）。
              label: t("openPublicPage"),
              icon: <GlobeIcon />,
              disabled: !menu.note.isPublic,
              disabledReason: privateNoteCopyReason(),
              onSelect: () =>
                window.open(
                  publicNoteUrl(window.location.origin, menu.note.id),
                  "_blank",
                  "noopener"
                ),
            },
            { separator: true },
            {
              label: t("menuHistory"),
              icon: <HistoryIcon />,
              onSelect: () => router.visit(`/notes/${menu.note.id}/history`),
            },
            {
              label: menu.note.pinned ? t("menuUnpin") : t("menuPin"),
              icon: <PinIcon />,
              onSelect: () => togglePin(menu.note),
            },
            { separator: true },
            {
              label: t("menuMoveToTrash"),
              icon: <TrashIcon />,
              danger: true,
              onSelect: () => trashNote(menu.note),
            },
          ]}
        />
      )}
    </div>
  );
}
