// repos.hashrock.info/switcher/v1.js が定義する Web Component（components/ServiceSwitcher.tsx）
import "react";

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "hashrock-switcher": {
        class?: string;
        floating?: boolean;
        theme?: "light" | "dark";
      };
    }
  }
}
