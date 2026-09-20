import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { t } from "../application/i18n";
import { useLocale } from "./useLocale";

interface Props {
  open: boolean;
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** "danger" は破壊的操作（赤系ボタン） */
  variant?: "danger" | "default";
  onConfirm: () => void;
  onCancel: () => void;
}

export default function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = "OK",
  cancelLabel,
  variant = "default",
  onConfirm,
  onCancel,
}: Props) {
  useLocale(); // 言語切り替えで再レンダー（t() の購読）
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    // 確認ボタンにフォーカスし、Escapeでキャンセル
    const t = setTimeout(() => confirmRef.current?.focus(), 0);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(t);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onCancel]);

  if (!open) return null;

  // Portal to <body>: a `position: fixed` overlay is positioned against the
  // nearest transformed ancestor, and the editor header animates in with a
  // transform (`.anim-header`) — a dialog opened from a header control
  // (PublicityDropdown) was otherwise centred inside the 48px header and cut
  // off at the top of the page.
  const portalTarget = typeof document === "undefined" ? null : document.body;

  const confirmClass =
    variant === "danger"
      ? "bg-red-600 hover:bg-red-700 focus:ring-red-100"
      : "bg-emerald-600 hover:bg-emerald-700 focus:ring-emerald-100";

  const dialog = (
    <div
      className="anim-overlay fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 px-4"
      onClick={onCancel}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div
        className="anim-modal w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-bold tracking-tight text-slate-950">
          {title}
        </h2>
        {message && (
          <p className="mt-2 text-sm leading-relaxed text-slate-500">
            {message}
          </p>
        )}
        <div className="mt-6 flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-xl px-4 py-2 text-sm font-medium text-slate-600 transition hover:bg-slate-100"
          >
            {cancelLabel ?? t("cancel")}
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={onConfirm}
            className={`rounded-xl px-4 py-2 text-sm font-semibold text-white shadow-sm transition focus:outline-none focus:ring-2 ${confirmClass}`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
  return portalTarget ? createPortal(dialog, portalTarget) : dialog;
}
