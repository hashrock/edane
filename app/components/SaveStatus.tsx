import { t } from "../application/i18n";
import type { SaveFailureReason } from "../application/saveTracker";
import { SAVE_FAILURE_MESSAGE } from "./useNoteEditor";
import { useLocale } from "./useLocale";

interface Props {
  /** The status line `useNoteEditor.updateSaveStatus` writes into. */
  statusRef: React.RefObject<HTMLSpanElement | null>;
  /** Why the last save failed, or null. Drives the explanation + retry. */
  failure: SaveFailureReason | null;
  onRetry: () => void;
}

/**
 * Header save status, shared by the canvas and outline headers. Normally just
 * the quiet "saving… / saved" line; when a save has failed it turns red and
 * adds the reason and a retry button so the user knows what happened and what
 * to do (usertest #3 — "保存失敗" alone told them neither).
 */
export default function SaveStatus({ statusRef, failure, onRetry }: Props) {
  useLocale(); // 言語切り替えで再レンダー（t() の購読）
  return (
    <span className="flex min-w-0 items-center gap-2 whitespace-nowrap text-xs">
      {/* The status line is written imperatively (updateSaveStatus) and so
          is lost when the header re-mounts on a layout switch; while a
          failure stands, show its label from React instead so the message
          survives the switch, and keep the imperative span out of sight. */}
      <span
        ref={statusRef}
        data-testid="save-status"
        className={failure ? "hidden" : "text-slate-600"}
      />
      {failure && (
        <>
          <span className="font-medium text-rose-600">{t("statusSaveFailed")}</span>
          <span
            data-testid="save-failure-reason"
            title={t(SAVE_FAILURE_MESSAGE[failure])}
            className="hidden max-w-[320px] truncate text-rose-600 lg:inline"
          >
            {t(SAVE_FAILURE_MESSAGE[failure])}
          </span>
          <button
            type="button"
            data-testid="save-retry"
            onClick={onRetry}
            className="rounded-md border border-rose-300 bg-white px-2 py-0.5 font-medium text-rose-700 hover:bg-rose-50"
          >
            {t("saveRetry")}
          </button>
        </>
      )}
    </span>
  );
}
