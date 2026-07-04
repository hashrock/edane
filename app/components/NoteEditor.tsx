import { useState, useEffect } from "react";
import { MindmapEditorView } from "./MindmapEditor";
import OutlineEditor from "./OutlineEditor";
import { useNoteEditor } from "./useNoteEditor";

interface Props {
  noteId?: string;
  initialContent?: string;
  initialTitle?: string;
  initialIsPublic?: boolean;
  embed?: boolean;
  onSaveToAccount?: (note: { title: string; content: string }) => void;
}

// Narrow-viewport breakpoint: below this the mind map gives way to the outline
// layout. Matches Tailwind's `md` so it lines up with the rest of the UI.
const NARROW_QUERY = "(max-width: 767px)";

type Layout = "canvas" | "outline";

/**
 * Responsive note editor: renders the Konva mind map on wide viewports and the
 * vertical outline on narrow ones, switching live as the width crosses the
 * breakpoint. Both views share a single {@link useNoteEditor} engine, so the
 * document, caret, selection and undo history survive the switch untouched.
 *
 * The layout follows the viewport width, but a hidden shortcut
 * (⌘/Ctrl+Shift+O) can force the outline on any width for those who prefer it.
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

  const layout: Layout = override ?? (mounted && narrow ? "outline" : "canvas");

  if (layout === "outline") {
    return (
      <OutlineEditor
        engine={engine}
        embed={props.embed}
        onSaveToAccount={props.onSaveToAccount}
      />
    );
  }
  return (
    <MindmapEditorView
      engine={engine}
      embed={props.embed}
      onSaveToAccount={props.onSaveToAccount}
    />
  );
}
