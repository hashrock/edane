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
 * A header button lets the user override the automatic choice (e.g. force the
 * mind map on a tablet, or the outline on a wide screen).
 */
export default function NoteEditor(props: Props) {
  const engine = useNoteEditor(props);

  // Auto choice follows the viewport; an explicit user override wins until the
  // user toggles again. Default to the mind map for SSR / first paint (there is
  // no viewport on the server) so hydration matches, then correct on mount.
  const [mounted, setMounted] = useState(false);
  const [narrow, setNarrow] = useState(false);
  const [override, setOverride] = useState<Layout | null>(null);

  useEffect(() => {
    setMounted(true);
    const mq = window.matchMedia(NARROW_QUERY);
    const update = () => setNarrow(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  const auto: Layout = narrow ? "outline" : "canvas";
  const layout: Layout = !mounted ? "canvas" : (override ?? auto);
  const switchLayout = () =>
    setOverride(layout === "canvas" ? "outline" : "canvas");

  if (layout === "outline") {
    return (
      <OutlineEditor
        engine={engine}
        embed={props.embed}
        onSaveToAccount={props.onSaveToAccount}
        onSwitchLayout={switchLayout}
      />
    );
  }
  return (
    <MindmapEditorView
      engine={engine}
      embed={props.embed}
      onSaveToAccount={props.onSaveToAccount}
      onSwitchLayout={switchLayout}
    />
  );
}
