import { useState, useEffect, useCallback, useMemo, lazy, Suspense } from "react";
import { MindmapEditorView } from "./MindmapEditor";
import OutlineEditor from "./OutlineEditor";
import SlideShow from "./SlideShow";
import WebPagePreview from "./WebPagePreview";
import { useNoteEditor } from "./useNoteEditor";
import type { EditorLayout } from "../application/editSurface";
import type { PageTheme } from "../domain/pageTheme";

const PageThemePanel = lazy(() => import("./PageThemePanel"));

interface Props {
  noteId?: string;
  initialContent?: string;
  initialTitle?: string;
  initialIsPublic?: boolean;
  embed?: boolean;
  /** 閲覧専用モード（公開ノートの閲覧ページなど）。編集・保存を全面無効化。 */
  readOnly?: boolean;
  onSaveToAccount?: (note: { title: string; content: string }) => void;
}

// Narrow-viewport breakpoint: below this the mind map gives way to the outline
// layout. Matches Tailwind's `md` so it lines up with the rest of the UI.
const NARROW_QUERY = "(max-width: 767px)";

type Layout = EditorLayout;

/**
 * Responsive note editor: renders the Konva mind map on wide viewports and the
 * vertical outline on narrow ones, switching live as the width crosses the
 * breakpoint. Both views share a single {@link useNoteEditor} engine, so the
 * document, caret, selection and undo history survive the switch untouched.
 *
 * The layout follows the viewport width, but the header view controls and a
 * hidden shortcut (⌘/Ctrl+Shift+O) can force either layout on any width for
 * those who prefer it.
 */
export default function NoteEditor(props: Props) {
  const engine = useNoteEditor(props);

  // The layout tracks the viewport. Default to the mind map for SSR / first
  // paint (there is no viewport on the server) so hydration matches, then
  // correct on mount.
  const [mounted, setMounted] = useState(false);
  const [narrow, setNarrow] = useState(false);
  // Manual override set by the hidden shortcut. null = follow the viewport.
  const [override, setOverride] = useState<Layout | null>(null);

  useEffect(() => {
    setMounted(true);
    const mq = window.matchMedia(NARROW_QUERY);
    const update = () => setNarrow(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  // Hidden power-user shortcut: ⌘/Ctrl+Shift+O forces the outline layout even on
  // wide viewports; pressing it again releases the override back to the
  // viewport-driven default.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "o") {
        e.preventDefault();
        setOverride((prev) => (prev === "outline" ? null : "outline"));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Presentation mode: the node the show started from (null = not presenting).
  const [show, setShow] = useState<{ from: string | null } | null>(null);
  const { stateRef, dispatch } = engine;
  // The editor keeps its focus: the show swallows keys above it, and Esc hands
  // the keyboard straight back.
  const present = useCallback(
    () => setShow({ from: stateRef.current.view.activeNodeId }),
    [stateRef]
  );
  // Leaving the show moves to the slide on screen, in the mode the editor was
  // in (the outline only takes keys while editing), so it picks up there.
  const endPresentation = useCallback(
    (nodeId: string | null) => {
      setShow(null);
      if (nodeId) {
        const { editing } = stateRef.current.view;
        dispatch({ type: "activateNode", nodeId, cursorPos: 0, selectionEnd: 0, editing });
      }
    },
    [dispatch, stateRef]
  );

  // Webページモード: the page preview in the top-right corner, and the theme panel.
  const [webMode, setWebMode] = useState(false);
  const [themePanel, setThemePanel] = useState(false);
  const webPage = useMemo(
    () => ({
      active: webMode,
      toggle: () => {
        setWebMode((on) => !on);
        setThemePanel(false);
      },
    }),
    [webMode]
  );
  const setTheme = useCallback(
    (theme: PageTheme | null) => dispatch({ type: "setTheme", theme }, "theme"),
    [dispatch]
  );

  const defaultLayout: Layout = mounted && narrow ? "outline" : "canvas";
  const layout: Layout = override ?? defaultLayout;

  // Picking the viewport-driven default releases the override, so resizing
  // across the breakpoint keeps switching layouts automatically again.
  const changeLayout = (next: Layout) =>
    setOverride(next === defaultLayout ? null : next);

  const viewProps = {
    engine,
    embed: props.embed,
    onSaveToAccount: props.onSaveToAccount,
    layout,
    onLayoutChange: changeLayout,
    onPresent: present,
    webPage,
  };
  return (
    <>
      {engine.syncError && <div role="alert" className="px-4 py-2 text-sm bg-amber-50 text-amber-950">
        {engine.syncError}
        {engine.syncRecovery && <details><summary>適用できなかった編集（復元用）</summary><textarea readOnly aria-label="未適用の編集" value={engine.syncRecovery} className="w-full h-24" /></details>}
      </div>}
      {layout === "outline" ? <OutlineEditor {...viewProps} /> : <MindmapEditorView {...viewProps} />}
      {webMode && (
        // Beside the theme panel (w-80) while it is open, so the two show together.
        <div className={`pointer-events-none fixed top-14 z-40 ${themePanel ? "right-[21rem]" : "right-3"}`}>
          <WebPagePreview
            doc={engine.model}
            activeNodeId={engine.state.view.activeNodeId}
            onOpenTheme={engine.readOnly ? undefined : () => setThemePanel(true)}
            onExit={() => webPage.toggle()}
          />
        </div>
      )}
      {webMode && themePanel && (
        <Suspense fallback={null}>
          <PageThemePanel
            theme={engine.model.theme}
            onChange={setTheme}
            onClose={() => setThemePanel(false)}
            readOnly={engine.readOnly}
            noteId={engine.noteId}
            isPublic={engine.isPublic}
          />
        </Suspense>
      )}
      {show && <SlideShow doc={engine.model} startNodeId={show.from} onExit={endPresentation} />}
    </>
  );
}
