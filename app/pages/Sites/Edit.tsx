import { Head } from "@inertiajs/react";
import SiteEditor, { type SiteEditorProps } from "../../components/SiteEditor";

// 公開サイト（JSXテンプレート）の編集ページ。マインドマップエディタとは独立。
export default function SitesEdit(props: SiteEditorProps) {
  return (
    <>
      <Head title={props.data.text} />
      <SiteEditor {...props} />
    </>
  );
}
