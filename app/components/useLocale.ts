/**
 * ロケールストア（application/i18n.ts）のReactバインディング。
 *
 * UI文言（`t()`）を描画するコンポーネントは必ずこのフックを呼ぶこと —
 * 戻り値のロケールを使わなくても、購読によって言語切り替え時に再レンダー
 * される（`t()` はストアを直接読むだけで再レンダーを起こさない）。
 * ラベルを useMemo で組み立てる場合は、返り値の locale を依存配列に入れて
 * メモを言語切り替えで無効化する。
 */

import { useSyncExternalStore } from "react";
import {
  getLocale,
  subscribeLocale,
  DEFAULT_LOCALE,
  type Locale,
} from "../application/i18n";

export function useLocale(): Locale {
  return useSyncExternalStore(subscribeLocale, getLocale, () => DEFAULT_LOCALE);
}
