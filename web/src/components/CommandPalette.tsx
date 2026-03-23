import { useState, useEffect, useRef, useCallback } from "react";

export interface Command {
  id: string;
  label: string;
  action: () => void;
}

interface Props {
  commands: Command[];
  open: boolean;
  onClose: () => void;
}

export default function CommandPalette({ commands, open, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = commands.filter((cmd) =>
    cmd.label.toLowerCase().includes(query.toLowerCase())
  );

  useEffect(() => {
    if (open) {
      setQuery("");
      setSelectedIndex(0);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  const execute = useCallback(
    (cmd: Command) => {
      onClose();
      cmd.action();
    },
    [onClose]
  );

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (filtered[selectedIndex]) {
        execute(filtered[selectedIndex]);
      }
    }
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[20vh]"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md bg-white rounded-lg shadow-2xl border overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="コマンドを検索..."
          className="w-full px-4 py-3 text-sm border-b outline-none"
        />
        <ul className="max-h-64 overflow-y-auto">
          {filtered.length === 0 ? (
            <li className="px-4 py-3 text-sm text-gray-400">
              該当するコマンドがありません
            </li>
          ) : (
            filtered.map((cmd, i) => (
              <li
                key={cmd.id}
                className={`px-4 py-2.5 text-sm cursor-pointer ${
                  i === selectedIndex
                    ? "bg-blue-50 text-blue-700"
                    : "hover:bg-gray-50"
                }`}
                onClick={() => execute(cmd)}
                onMouseEnter={() => setSelectedIndex(i)}
              >
                {cmd.label}
              </li>
            ))
          )}
        </ul>
      </div>
    </div>
  );
}
