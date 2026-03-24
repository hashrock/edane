import { Link } from "react-router-dom";
import MindmapEditor from "../components/MindmapEditor";
import { isElectron } from "../hooks/useElectron";

export default function GuestPage() {
  const electron = isElectron();

  return (
    <div className={`h-screen flex flex-col ${electron ? "electron-transparent" : ""}`}>
      <header
        className="flex items-center gap-2 md:gap-4 px-3 md:px-4 py-2 border-b bg-white flex-wrap"
        data-electron-interactive
      >
        <Link to="/notes" className="text-blue-600 hover:underline text-sm">
          &larr; 一覧
        </Link>
        <h1 className="font-semibold text-sm md:text-base">ゲストエディタ</h1>
        <span className="text-xs text-gray-400">
          保存はされません（ローカルのみ）
        </span>
      </header>
      <div className="flex-1 overflow-hidden" data-electron-interactive>
        <MindmapEditor />
      </div>
    </div>
  );
}
