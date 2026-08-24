import { useAnchoredPopover } from "./useAnchoredPopover";
import { GlobeIcon, LinkIcon, LockIcon } from "./icons";
import { privateNoteCopyReason } from "../application/publicNoteLink";
import { t } from "../application/i18n";
import { useLocale } from "./useLocale";

interface Props {
  isPublic: boolean;
  /** Called with the newly chosen publicity when the user picks an option. */
  onChange: (next: boolean) => void;
  /**
   * 「リンクをコピー」を押したときのハンドラ。未指定なら項目自体を出さない
   * （共有できるURLが無い＝未保存ノート/ゲスト）。指定した場合、非公開の間は
   * 無効化して理由を見せる（{@link privateNoteCopyReason}）。
   */
  onCopyLink?: () => void;
}

// label はカタログキー（描画時に t() で解決 — 言語切り替えに追従する）。
const OPTIONS = [
  { value: false, label: "privateLabel", icon: <LockIcon width="15" height="15" /> },
  { value: true, label: "publicLabel", icon: <GlobeIcon width="15" height="15" /> },
] as const;

/**
 * Publicity selector rendered as a dropdown (replaces the old "公開する"
 * checkbox). The trigger shows the current state; the menu lists both options
 * with a check next to the active one. The top-layer popover + anchor
 * positioning mechanics live in {@link useAnchoredPopover}.
 *
 * `onCopyLink` を渡すと、公開状態の下に「リンクをコピー」が並ぶ。共有できるか
 * どうかは公開状態そのものなので、共有動線もこのメニューに同居させている。
 */
export default function PublicityDropdown({
  isPublic,
  onChange,
  onCopyLink,
}: Props) {
  useLocale(); // 言語切り替えで再レンダー（t() の購読）
  const menu = useAnchoredPopover("down");

  return (
    <>
      <button
        type="button"
        ref={menu.triggerRef}
        popoverTarget={menu.popId}
        style={menu.triggerStyle}
        className="flex items-center gap-1.5 whitespace-nowrap rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
      >
        <span className="text-slate-500">
          {isPublic ? (
            <GlobeIcon width="15" height="15" />
          ) : (
            <LockIcon width="15" height="15" />
          )}
        </span>
        {isPublic ? t("publicLabel") : t("privateLabel")}
        <span
          className={`text-xs text-slate-500 transition-transform ${
            menu.open ? "rotate-180" : ""
          }`}
        >
          ▾
        </span>
      </button>
      <div
        ref={menu.popoverRef}
        id={menu.popId}
        popover="auto"
        onToggle={menu.handleToggle}
        style={menu.popoverStyle}
        className="min-w-[140px] overflow-hidden rounded-lg border border-slate-200 bg-white p-1 shadow-xl"
      >
        {OPTIONS.map((opt) => (
          <button
            key={String(opt.value)}
            type="button"
            onClick={() => {
              menu.popoverRef.current?.hidePopover();
              if (opt.value !== isPublic) onChange(opt.value);
            }}
            className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs text-slate-700 hover:bg-slate-100"
          >
            <span className="text-slate-500">{opt.icon}</span>
            <span className="flex-1">{t(opt.label)}</span>
            {opt.value === isPublic && <span className="text-slate-900">✓</span>}
          </button>
        ))}
        {onCopyLink && (
          <>
            <div className="my-1 border-t border-slate-200" role="separator" />
            <button
              type="button"
              disabled={!isPublic}
              data-testid="copy-link"
              onClick={() => {
                menu.popoverRef.current?.hidePopover();
                onCopyLink();
              }}
              className="flex w-full items-start gap-2 rounded-md px-2.5 py-1.5 text-left text-xs text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:text-slate-400 disabled:hover:bg-transparent"
            >
              <span className="mt-px text-slate-500">
                <LinkIcon width="15" height="15" />
              </span>
              <span className="flex-1">
                {t("copyLinkLabel")}
                {!isPublic && (
                  <span className="mt-0.5 block text-[11px] text-slate-400">
                    {privateNoteCopyReason()}
                  </span>
                )}
              </span>
            </button>
          </>
        )}
      </div>
    </>
  );
}
