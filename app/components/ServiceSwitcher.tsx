/**
 * hashrock のサービス切り替え（他の star 済みプロジェクトへ移るメニュー）。
 *
 * 中身は repos.hashrock.info が配る Web Component（<hashrock-switcher>）で、
 * スクリプトは root-view.tsx で 1 回だけ読む。各画面のヘッダの右端に置く。
 * 読み込めなくてもこの要素が空のまま残るだけで、ページの表示や操作は妨げない。
 */
export default function ServiceSwitcher({ className }: { className?: string }) {
  return <hashrock-switcher class={className} />;
}
