/**
 * Property-based tests for the two view/edit access policies. Both are pure
 * decisions over a small, fully enumerable state (note present/missing,
 * trashed/live, public/private, owner/stranger/logged-out), so — unlike
 * noteAccess.test.ts's hand-picked scenarios — a property test can hold the
 * WHOLE decision table to the security invariants at once: a missing or
 * trashed note never renders or reveals which case it is, and a private note
 * never renders (nor exposes edit access) for anyone but its owner.
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { resolveEditPageAccess, resolveViewPageAccess } from "./noteAccess";

const owner = { id: "owner-1" };
const stranger = { id: "someone-else" };
const TRASHED_AT = "2026-08-01T00:00:00Z";

type Note = { userId: string | null; isPublic: boolean; deletedAt: string | null };

/** Shared by both oracle tests below so "live" can't drift between them. */
function isLive(note: Note | undefined): note is Note {
  return note !== undefined && note.deletedAt === null;
}

const noteArb: fc.Arbitrary<Note> = fc.record({
  userId: fc.constantFrom(owner.id, stranger.id, null),
  isPublic: fc.boolean(),
  deletedAt: fc.constantFrom(null, TRASHED_AT),
});
const maybeNoteArb = fc.oneof(fc.constant(undefined), noteArb);
const viewerArb = fc.constantFrom(owner, stranger, null);

describe("resolveEditPageAccess", () => {
  it("renders only for the live note's owner; otherwise redirects by publicity, else hides", () => {
    fc.assert(
      fc.property(maybeNoteArb, viewerArb, (note, viewer) => {
        const result = resolveEditPageAccess({ note, viewer });
        const live = isLive(note);
        const owns = live && viewer !== null && note.userId === viewer.id;

        if (!live) expect(result).toEqual({ kind: "not-found" });
        else if (owns) expect(result).toEqual({ kind: "render", note, viewer });
        else if (note.isPublic) expect(result).toEqual({ kind: "redirect-to-view" });
        else if (viewer === null) expect(result).toEqual({ kind: "redirect-to-home" });
        else expect(result).toEqual({ kind: "not-found" });
      })
    );
  });
});

describe("resolveViewPageAccess", () => {
  it("renders iff the note is live and either public or owned by the viewer", () => {
    fc.assert(
      fc.property(maybeNoteArb, viewerArb, (note, viewer) => {
        const result = resolveViewPageAccess({ note, viewer });
        const live = isLive(note);
        const visible = live && (note.isPublic || (viewer !== null && note.userId === viewer.id));
        expect(result).toEqual(visible ? { kind: "render", note, viewer } : { kind: "not-found" });
      })
    );
  });
});

describe("security invariants shared by both pages", () => {
  it("a missing or trashed note never renders and never distinguishes itself from any other not-found", () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.constant(undefined), noteArb.map((n) => ({ ...n, deletedAt: TRASHED_AT }))),
        viewerArb,
        (note, viewer) => {
          expect(resolveEditPageAccess({ note, viewer })).toEqual({ kind: "not-found" });
          expect(resolveViewPageAccess({ note, viewer })).toEqual({ kind: "not-found" });
        }
      )
    );
  });

  it("a private live note never renders, and never renders the edit page, for anyone but its owner", () => {
    fc.assert(
      fc.property(
        noteArb.filter((n) => !n.isPublic && n.deletedAt === null),
        fc.boolean(),
        (note, loggedOut) => {
          // Derived from `note` rather than fixed to "stranger": a fixed viewer
          // would coincidentally BE the owner whenever the generated userId
          // happened to match it.
          const viewer = loggedOut ? null : note.userId === stranger.id ? owner : stranger;
          expect(resolveViewPageAccess({ note, viewer })).toEqual({ kind: "not-found" });
          expect(resolveEditPageAccess({ note, viewer }).kind).not.toBe("render");
        }
      )
    );
  });

  it("a public live note is always viewable, and its edit page always resolves to a render or a view redirect (never hidden)", () => {
    fc.assert(
      fc.property(
        noteArb.filter((n) => n.isPublic && n.deletedAt === null),
        viewerArb,
        (note, viewer) => {
          expect(resolveViewPageAccess({ note, viewer })).toEqual({ kind: "render", note, viewer });
          const editKind = resolveEditPageAccess({ note, viewer }).kind;
          expect(editKind === "render" || editKind === "redirect-to-view").toBe(true);
        }
      )
    );
  });
});
