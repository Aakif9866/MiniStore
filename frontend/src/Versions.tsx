import { Download, History, RotateCcw, Trash2, Upload, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, type FileDto, type VersionDto } from "./api";
import { formatSize, timeAgo } from "./format";

/** Version history for one file, in a native <dialog> (focus trap and Esc-to-close for free). */
export function Versions({ file, onClose, onChanged }: {
  file: FileDto;
  onClose: () => void;
  onChanged: (updated?: FileDto) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const [versions, setVersions] = useState<VersionDto[] | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState("");

  const load = () => api.versions(file.id).then(setVersions).catch((e) => setError(e.message));
  useEffect(() => {
    dialog.current?.showModal();
    void load();
  }, []);

  async function run(action: () => Promise<FileDto | void>) {
    setError("");
    try {
      onChanged((await action()) ?? undefined);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const uploadNew = (f: File) =>
    run(async () => {
      setProgress(0);
      try {
        return await api.uploadVersion(file.id, f, setProgress);
      } finally {
        setProgress(null);
      }
    });

  return (
    <dialog
      ref={dialog}
      onClose={onClose}
      className="m-auto w-[min(36rem,calc(100vw-2rem))] rounded-tl-3xl rounded-br-3xl border border-gray-200 bg-white p-0 text-gray-800 shadow-2xl backdrop:bg-black/60 dark:border-white/10 dark:bg-ink-800 dark:text-gray-200"
    >
      <div className="flex items-start justify-between gap-4 border-b border-gray-200 p-5 dark:border-white/10">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <History size={18} className="text-teal-600 dark:text-teal-400" /> Version history
          </h2>
          <p className="truncate text-sm text-gray-500 dark:text-gray-400" title={file.name}>{file.name}</p>
        </div>
        <button onClick={() => dialog.current?.close()} aria-label="Close" className="rounded-lg p-1 hover:bg-gray-100 dark:hover:bg-white/10">
          <X size={18} />
        </button>
      </div>

      <div className="max-h-[60vh] overflow-y-auto p-5">
        {error && <p role="alert" className="mb-3 rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400">{error}</p>}
        {!versions && <p className="text-sm text-gray-500">Loading…</p>}
        <ol className="space-y-2">
          {versions?.map((v, i) => (
            <li
              key={v.versionId}
              className={`flex items-center gap-3 rounded-lg border p-3 ${v.isCurrent ? "border-teal-500 bg-teal-500/5" : "border-gray-200 dark:border-white/10"}`}
            >
              <span className="w-8 shrink-0 text-center text-xs font-semibold text-gray-500">v{versions.length - i}</span>
              <div className="min-w-0 flex-1">
                <p className="text-sm">
                  {formatSize(v.size)}
                  {v.isCurrent && <span className="brand-gradient ml-2 rounded-full px-2 py-0.5 text-xs font-medium text-white">current</span>}
                </p>
                <p className="text-xs text-gray-500 italic dark:text-gray-400">{timeAgo(v.createdAt)}</p>
              </div>
              <IconButton label="Download this version" onClick={() => api.downloadVersion(file.id, v.versionId).catch((e) => setError(e.message))}>
                <Download size={15} />
              </IconButton>
              {!v.isCurrent && (
                <>
                  <IconButton label="Restore this version" onClick={() => run(() => api.restoreVersion(file.id, v.versionId))}>
                    <RotateCcw size={15} />
                  </IconButton>
                  <IconButton
                    label="Delete this version"
                    danger
                    onClick={() => confirm("Delete this old version permanently?") && run(() => api.deleteVersion(file.id, v.versionId))}
                  >
                    <Trash2 size={15} />
                  </IconButton>
                </>
              )}
            </li>
          ))}
        </ol>
      </div>

      <div className="border-t border-gray-200 p-5 dark:border-white/10">
        {progress !== null ? (
          <div className="h-1.5 overflow-hidden rounded-full bg-gray-200 dark:bg-ink-900">
            <div className="brand-gradient h-full transition-[width] duration-200" style={{ width: `${progress * 100}%` }} />
          </div>
        ) : (
          <button
            onClick={() => picker.current?.click()}
            className="brand-gradient flex w-full items-center justify-center gap-2 rounded-lg py-2.5 font-semibold text-white transition-transform duration-150 hover:brightness-110 active:scale-95"
          >
            <Upload size={16} /> Upload a new version
          </button>
        )}
        <input ref={picker} type="file" hidden onChange={(e) => e.target.files?.[0] && uploadNew(e.target.files[0])} />
      </div>
    </dialog>
  );
}

function IconButton({ label, danger, onClick, children }: {
  label: string;
  danger?: boolean;
  onClick: () => unknown;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      title={label}
      className={`rounded-lg border border-gray-200 p-2 text-gray-500 transition-colors duration-150 active:scale-95 dark:border-white/10 ${
        danger ? "hover:border-red-500 hover:bg-red-500 hover:text-white" : "hover:border-teal-500 hover:bg-teal-500 hover:text-white"
      }`}
    >
      {children}
    </button>
  );
}
