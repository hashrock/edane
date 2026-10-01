/** アクセントカラーストア（application/accentColor.ts）のReactバインディング。 */

import { useSyncExternalStore } from "react";
import {
  DEFAULT_ACCENT,
  getAccent,
  subscribeAccent,
} from "../application/accentColor";

export function useAccent(): string {
  return useSyncExternalStore(subscribeAccent, getAccent, () => DEFAULT_ACCENT);
}
