import { describe, expect, it } from "vitest";
import { resolveEditPageAccess, resolveViewPageAccess } from "./noteAccess";

const owner = { id: "owner-1" };
const stranger = { id: "someone-else" };

type NoteFields = { userId: string | null; isPublic: boolean; deletedAt: string | null };

function note(overrides: Partial<NoteFields> = {}): NoteFields {
  return { userId: owner.id, isPublic: false, deletedAt: null, ...overrides };
}

const TRASHED_AT = "2026-08-01T00:00:00Z";

describe("resolveEditPageAccess", () => {
  it("renders for the owner, carrying the note and viewer through narrowed", () => {
    const own = note();
    expect(resolveEditPageAccess({ note: own, viewer: owner })).toEqual({
      kind: "render",
      note: own,
      viewer: owner,
    });

    const shared = note({ isPublic: true });
    expect(resolveEditPageAccess({ note: shared, viewer: owner }).kind).toBe("render");
  });

  it("sends a non-owner to the read-only view when the note is public", () => {
    expect(resolveEditPageAccess({ note: note({ isPublic: true }), viewer: stranger })).toEqual({
      kind: "redirect-to-view",
    });
    // Logged-out visitors following a shared edit URL land on the view too.
    expect(resolveEditPageAccess({ note: note({ isPublic: true }), viewer: null })).toEqual({
      kind: "redirect-to-view",
    });
  });

  it("hides a private note from a signed-in non-owner", () => {
    expect(resolveEditPageAccess({ note: note(), viewer: stranger })).toEqual({
      kind: "not-found",
    });
  });

  it("sends a logged-out visitor to the landing page for a private note", () => {
    // They may be the owner with an expired session, so 404 would be wrong.
    expect(resolveEditPageAccess({ note: note(), viewer: null })).toEqual({
      kind: "redirect-to-home",
    });
  });

  it("is not-found for a missing or trashed note, even for the owner", () => {
    expect(resolveEditPageAccess({ note: undefined, viewer: owner })).toEqual({
      kind: "not-found",
    });
    expect(resolveEditPageAccess({ note: note({ deletedAt: TRASHED_AT }), viewer: owner })).toEqual({
      kind: "not-found",
    });
    // A trashed public note doesn't leak through the view redirect either.
    expect(
      resolveEditPageAccess({
        note: note({ isPublic: true, deletedAt: TRASHED_AT }),
        viewer: stranger,
      })
    ).toEqual({ kind: "not-found" });
  });

  it("never treats an ownerless note as owned", () => {
    expect(resolveEditPageAccess({ note: note({ userId: null }), viewer: owner })).toEqual({
      kind: "not-found",
    });
  });
});

describe("resolveViewPageAccess", () => {
  it("renders for the owner", () => {
    const own = note();
    expect(resolveViewPageAccess({ note: own, viewer: owner })).toEqual({
      kind: "render",
      note: own,
      viewer: owner,
    });
  });

  it("renders a public note for anyone, including a logged-out visitor", () => {
    const shared = note({ isPublic: true });
    expect(resolveViewPageAccess({ note: shared, viewer: stranger })).toEqual({
      kind: "render",
      note: shared,
      viewer: stranger,
    });
    expect(resolveViewPageAccess({ note: shared, viewer: null })).toEqual({
      kind: "render",
      note: shared,
      viewer: null,
    });
  });

  it("hides a private note from a signed-in non-owner and from a logged-out visitor", () => {
    expect(resolveViewPageAccess({ note: note(), viewer: stranger })).toEqual({
      kind: "not-found",
    });
    expect(resolveViewPageAccess({ note: note(), viewer: null })).toEqual({
      kind: "not-found",
    });
  });

  it("is not-found for a missing or trashed note, even for the owner", () => {
    expect(resolveViewPageAccess({ note: undefined, viewer: owner })).toEqual({
      kind: "not-found",
    });
    expect(resolveViewPageAccess({ note: note({ deletedAt: TRASHED_AT }), viewer: owner })).toEqual({
      kind: "not-found",
    });
    // A trashed public note doesn't leak through either.
    expect(
      resolveViewPageAccess({
        note: note({ isPublic: true, deletedAt: TRASHED_AT }),
        viewer: stranger,
      })
    ).toEqual({ kind: "not-found" });
  });

  it("never treats an ownerless note as owned", () => {
    expect(resolveViewPageAccess({ note: note({ userId: null }), viewer: owner })).toEqual({
      kind: "not-found",
    });
  });
});
