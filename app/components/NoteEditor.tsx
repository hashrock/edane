import { useState, useEffect, useCallback } from "react";
import { MindmapEditorView } from "./MindmapEditor";
import OutlineEditor from "./OutlineEditor";
import SlideShow from "./SlideShow";
import { useNoteEditor } from "./useNoteEditor";
import type { EditorLayout } from "../application/editSurface";

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
  const present = useCallback(() => {
    (document.activeElement as HTMLElement | null)?.blur();
    setShow({ from: stateRef.current.view.activeNodeId });
  }, [stateRef]);
  // Leaving the show selects the slide on screen, so the editor picks up there.
  const endPresentation = useCallback(
    (nodeId: string | null) => {
      setShow(null);
      if (nodeId) {
        dispatch({ type: "activateNode", nodeId, cursorPos: 0, selectionEnd: 0, editing: false });
      }
    },
    [dispatch]
  );

  // F5 starts the show, as in PowerPoint (and instead of reloading the page).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "F5" && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        present();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [present]);

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
  };
  return (
    <>
      {layout === "outline" ? <OutlineEditor {...viewProps} /> : <MindmapEditorView {...viewProps} />}
      {show && <SlideShow doc={engine.model} startNodeId={show.from} onExit={endPresentation} />}
    </>
  );
}
