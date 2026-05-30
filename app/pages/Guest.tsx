import { Head, Link } from "@inertiajs/react";
import MindmapEditor from "../components/MindmapEditor";

export default function Guest() {
  return (
    <div className="h-screen flex flex-col">
      <Head title="ゲストエディタ" />
      <header className="flex items-center gap-2 md:gap-4 px-3 md:px-4 py-2 border-b bg-white flex-wrap">
        <Link href="/notes" className="text-blue-600 hover:underline text-sm">
          &larr; 一覧
        </Link>
        <h1 className="font-semibold text-sm md:text-base">ゲストエディタ</h1>
        <span className="text-xs text-gray-400">
          保存はされません（ローカルのみ）
        </span>
      </header>
      <div className="flex-1 overflow-hidden">
        <MindmapEditor />
      </div>
    </div>
  );
}
