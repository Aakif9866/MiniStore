import { RotateCcw, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { api, type TrashedFileDto } from "./api";
import { formatSize, timeAgo } from "./format";

/** Files in the trash: restore them, delete them for good, or wait for the automatic purge. */
export function Trash({ onChanged, report }: { onChanged: () => void; report: (err: unknown) => void }) {
  const [items, setItems] = useState<TrashedFileDto[] | null>(null);
  const load = () => api.trash().then(setItems).catch(report);
  useEffect(() => void load(), []);

  const act = (action: Promise<unknown>) =>
    action.then(() => (load(), onChanged())).catch(report);

  if (!items) return <p className="mt-10 text-center text-gray-500">Loading…</p>;

  return (
    <section className="mt-6 motion-safe:animate-rise">
      <div className="flex flex-col gap-3 rounded-tl-3xl rounded-br-3xl border border-amber-500/40 bg-amber-500/10 p-4 text-sm sm:flex-row sm:items-center sm:justify-between">
        <p className="text-amber-800 dark:text-amber-200">
          Files in the trash still count toward your storage and are deleted for good after 30 days.
        </p>
        {items.length > 0 && (
          <button
            onClick={() => confirm(`Permanently delete ${items.length} file(s)? This can't be undone.`) && act(api.emptyTrash())}
            className="shrink-0 rounded-lg border border-red-500 px-3 py-1.5 font-medium text-red-600 transition-colors duration-150 hover:bg-red-500 hover:text-white active:scale-95 dark:text-red-400"
          >
            Empty trash
          </button>
        )}
      </div>

      {items.length === 0 && (
        <div className="mt-16 text-center text-gray-500 dark:text-gray-400">
          <Trash2 size={40} className="mx-auto text-amber-500" />
          <p className="mt-3">The trash is empty.</p>
        </div>
      )}

      <ul className="mt-4 space-y-2">
        {items.map((f) => (
          <li key={f.id} className="flex items-center gap-3 rounded-lg border border-gray-200 bg-white p-3 dark:border-white/10 dark:bg-ink-900">
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium" title={f.name}>{f.name}</p>
              <p className="text-xs text-gray-500 italic dark:text-gray-400">
                {formatSize(f.size)} · deleted {timeAgo(f.deletedAt)} · gone {timeAgo(f.purgeAt)}
              </p>
            </div>
            <button
              onClick={() => act(api.restoreFromTrash(f.id))}
              className="flex items-center gap-1.5 rounded-lg border border-teal-500 px-3 py-1.5 text-sm text-teal-700 transition-colors duration-150 hover:bg-teal-500 hover:text-white active:scale-95 dark:text-teal-400"
            >
              <RotateCcw size={15} /> Restore
            </button>
            <button
              onClick={() => confirm(`Delete "${f.name}" forever?`) && act(api.deleteForever(f.id))}
              aria-label={`Delete ${f.name} forever`}
              title="Delete forever"
              className="rounded-lg border border-gray-200 p-2 text-gray-500 transition-colors duration-150 hover:border-red-500 hover:bg-red-500 hover:text-white active:scale-95 dark:border-white/10"
            >
              <Trash2 size={15} />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
