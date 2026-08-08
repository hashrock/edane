/**
 * システムクリップボードへの書き込み（フォールバック付き）。
 *
 * `navigator.clipboard` は secure context（https / localhost）にしか生えておらず、
 * 生えていても権限やユーザー操作との距離次第で reject する。共有リンクのコピーの
 * ように「押したのに何も起きない」が致命的な動線では、旧来の
 * `document.execCommand("copy")` へ落として最後まで試す。
 */

/**
 * `text` をクリップボードへコピーする。
 *
 * @returns コピーできたら true、どの経路も失敗したら false。呼び出し側は戻り値で
 *   成功／失敗のフィードバックを出し分けること（例外は投げない）。
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 非セキュアコンテキストや権限拒否。同期フォールバックへ。
  }
  return copyViaExecCommand(text);
}

/**
 * 画面外の textarea を選択して `execCommand("copy")` する旧来の方法。
 *
 * 呼び出し前のフォーカスを必ず復元する: エディタは共有 textarea にフォーカスを
 * 置いたままキーボード操作を成立させているので、ここでフォーカスを奪いっぱなしに
 * すると矢印キーの行き先が変わってしまう（CLAUDE.md のキーボード不変条件）。
 */
function copyViaExecCommand(text: string): boolean {
  const prevFocus = document.activeElement as HTMLElement | null;
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  // display:none だと選択できないので、画面外へ逃がすだけにする。
  ta.style.position = "fixed";
  ta.style.top = "0";
  ta.style.left = "-9999px";
  document.body.appendChild(ta);
  try {
    ta.select();
    ta.setSelectionRange(0, text.length);
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    ta.remove();
    prevFocus?.focus?.();
  }
}
