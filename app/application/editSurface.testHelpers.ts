import type { EditorAction, EditorState } from "./editorReducer";

/** A dispatch stub that records actions; the returned state is never inspected
 *  by handleAuxInputKeys, so a bare object cast is enough. Shared by
 *  editSurface.test.ts (example cases) and editSurface.property.test.ts
 *  (arbitrary text/caret) so the stub can't drift between the two. */
export function recorder() {
  const actions: EditorAction[] = [];
  const dispatch = (action: EditorAction) => {
    actions.push(action);
    return {} as EditorState;
  };
  return { actions, dispatch };
}
