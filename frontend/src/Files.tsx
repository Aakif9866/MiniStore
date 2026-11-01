import {
  Download,
  File as FileIcon,
  FileArchive,
  FileAudio,
  FileCode,
  FileImage,
  FileText,
  FileVideo,
  HardDrive,
  LogOut,
  Search,
  Trash2,
  UploadCloud,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, setToken, type FileDto } from "./api";
import { Logo } from "./App";

type Upload = { key: string; name: string; progress: number };

const bytes = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
function formatSize(n: number) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = n > 0 ? Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1) : 0;
  return `${bytes.format(n / 1024 ** i)} ${units[i]}`;
}

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
function timeAgo(iso: string) {
  const s = (new Date(iso).getTime() - Date.now()) / 1000;
  for (const [unit, secs] of [["day", 86400], ["hour", 3600], ["minute", 60]] as const) {
    if (Math.abs(s) >= secs) return rtf.format(Math.round(s / secs), unit);
  }
  return "just now";
}

// Icon + tint per file family: colour lives in icons, not in more buttons.
function fileKind(mime: string) {
  if (mime.startsWith("image/")) return { Icon: FileImage, tint: "text-pink-500 bg-pink-500/10" };
  if (mime.startsWith("video/")) return { Icon: FileVideo, tint: "text-purple-500 bg-purple-500/10" };
  if (mime.startsWith("audio/")) return { Icon: FileAudio, tint: "text-amber-500 bg-amber-500/10" };
  if (/zip|tar|gzip|compressed|rar|7z/.test(mime)) return { Icon: FileArchive, tint: "text-orange-500 bg-orange-500/10" };
  if (/json|javascript|xml|html|css|x-sh|typescript/.test(mime)) return { Icon: FileCode, tint: "text-indigo-500 bg-indigo-500/10" };
  if (mime.startsWith("text/") || mime === "application/pdf") return { Icon: FileText, tint: "text-teal-500 bg-teal-500/10" };
  return { Icon: FileIcon, tint: "text-gray-500 bg-gray-500/10" };
}

export function Files() {
  const [files, setFiles] = useState<FileDto[] | null>(null);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [dragging, setDragging] = useState(false);
  const picker = useRef<HTMLInputElement>(null);

  const report = (err: unknown) => setError((err as Error).message);
  const refresh = useCallback(() => api.listFiles().then(setFiles).catch(report), []);
  useEffect(() => void refresh(), [refresh]);

  function uploadAll(list: FileList | null) {
    if (!list?.length) return;
    setError("");
    for (const file of Array.from(list)) {
      const key = crypto.randomUUID();
      setUploads((u) => [...u, { key, name: file.name, progress: 0 }]);
      api
        .upload(file, (p) => setUploads((u) => u.map((x) => (x.key === key ? { ...x, progress: p } : x))))
        .then((dto) => setFiles((f) => [dto, ...(f ?? [])]))
        .catch((err) => report(new Error(`${file.name}: ${err.message}`)))
        .finally(() => setUploads((u) => u.filter((x) => x.key !== key)));
    }
  }

  async function remove(file: FileDto) {
    if (!confirm(`Delete "${file.name}"? This can't be undone.`)) return;
    try {
      await api.deleteFile(file.id);
      setFiles((f) => f!.filter((x) => x.id !== file.id));
    } catch (err) {
      report(err);
    }
  }

  const shown = files?.filter((f) => f.name.toLowerCase().includes(query.toLowerCase())) ?? [];
  const totalSize = files?.reduce((sum, f) => sum + f.size, 0) ?? 0;

  return (
    <div className="mx-auto max-w-6xl p-4 sm:p-6">
      <header className="flex items-center justify-between py-2">
        <Logo />
        <button
          onClick={() => setToken(null)}
          className="flex items-center gap-2 rounded-lg border border-teal-500 px-3 py-1.5 text-sm text-teal-700 transition-colors duration-150 hover:bg-teal-500 hover:text-white active:scale-95 dark:text-teal-400"
        >
          <LogOut size={16} /> Sign out
        </button>
      </header>

      <section className="mt-8 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-3xl font-bold lg:text-5xl">Your files</h1>
          <p className="mt-2 flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
            <HardDrive size={16} className="text-teal-500" />
            {files ? `${files.length} file${files.length === 1 ? "" : "s"} · ${formatSize(totalSize)}` : "Loading…"}
          </p>
        </div>
        <label className="relative sm:w-72">
          <Search size={16} className="absolute top-1/2 left-3 -translate-y-1/2 text-gray-400" />
          <span className="sr-only">Search files</span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search files…"
            className="w-full rounded-lg border border-gray-300 bg-white py-2 pr-3 pl-9 outline-none transition-colors duration-150 focus:border-teal-500 focus:ring-2 focus:ring-teal-500/30 dark:border-white/10 dark:bg-ink-900"
          />
        </label>
      </section>

      <button
        onClick={() => picker.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          uploadAll(e.dataTransfer.files);
        }}
        className={`mt-6 flex w-full flex-col items-center gap-2 rounded-tl-3xl rounded-br-3xl border-2 border-dashed p-8 transition-all duration-200 sm:p-10 ${
          dragging
            ? "scale-[1.01] border-teal-500 bg-teal-500/10"
            : "border-gray-300 hover:border-teal-500 dark:border-white/15"
        }`}
      >
        <span className="brand-gradient grid size-12 place-items-center rounded-full text-white">
          <UploadCloud size={24} />
        </span>
        <span className="font-semibold">Drop files here or click to upload</span>
        <span className="text-xs text-gray-500 dark:text-gray-400">Stored as objects in MinIO</span>
      </button>
      <input ref={picker} type="file" multiple hidden onChange={(e) => (uploadAll(e.target.files), (e.target.value = ""))} />

      {error && (
        <p role="alert" className="mt-4 flex justify-between gap-4 rounded-lg bg-red-500/10 px-4 py-3 text-sm text-red-600 dark:text-red-400">
          {error}
          <button onClick={() => setError("")} className="font-medium hover:underline">
            Dismiss
          </button>
        </p>
      )}

      {uploads.length > 0 && (
        <ul className="mt-4 space-y-2">
          {uploads.map((u) => (
            <li key={u.key} className="rounded-lg border border-gray-200 bg-white p-3 dark:border-white/10 dark:bg-ink-900">
              <div className="flex justify-between text-sm">
                <span className="truncate">{u.name}</span>
                <span className="text-gray-500 tabular-nums">{Math.round(u.progress * 100)}%</span>
              </div>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-gray-200 dark:bg-ink-800">
                <div className="brand-gradient h-full transition-[width] duration-200" style={{ width: `${u.progress * 100}%` }} />
              </div>
            </li>
          ))}
        </ul>
      )}

      {files && shown.length === 0 && (
        <div className="mt-16 text-center text-gray-500 dark:text-gray-400 motion-safe:animate-rise">
          <FileIcon size={40} className="mx-auto text-purple-500" />
          <p className="mt-3">{files.length ? "No files match your search." : "No files yet — upload your first one."}</p>
        </div>
      )}

      <ul className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {shown.map((f, i) => {
          const { Icon, tint } = fileKind(f.mimeType);
          return (
            <li
              key={f.id}
              style={{ animationDelay: `${Math.min(i, 12) * 40}ms` }}
              className="group flex flex-col rounded-tl-3xl rounded-br-3xl border border-gray-200 bg-white p-4 transition-all duration-200 hover:border-teal-500 motion-safe:animate-rise motion-safe:hover:-translate-y-1 hover:shadow-lg dark:border-white/10 dark:bg-ink-900 dark:hover:border-teal-400"
            >
              <div className="flex items-start gap-3">
                <span className={`grid size-11 shrink-0 place-items-center rounded-tl-xl rounded-br-xl ${tint}`}>
                  <Icon size={22} />
                </span>
                <div className="min-w-0">
                  <h2 className="line-clamp-2 font-semibold break-all" title={f.name}>
                    {f.name}
                  </h2>
                  <p className="mt-1 text-xs text-gray-500 italic dark:text-gray-400">
                    {formatSize(f.size)} · {timeAgo(f.createdAt)}
                  </p>
                </div>
              </div>
              <div className="mt-4 flex gap-2 pt-1 sm:opacity-60 sm:transition-opacity sm:group-hover:opacity-100 sm:focus-within:opacity-100">
                <button
                  onClick={() => api.download(f).catch(report)}
                  className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-teal-500 py-1.5 text-sm text-teal-700 transition-colors duration-150 hover:bg-teal-500 hover:text-white active:scale-95 dark:text-teal-400"
                >
                  <Download size={15} /> Download
                </button>
                <button
                  onClick={() => remove(f)}
                  aria-label={`Delete ${f.name}`}
                  className="rounded-lg border border-gray-200 px-3 text-gray-500 transition-colors duration-150 hover:border-red-500 hover:bg-red-500 hover:text-white active:scale-95 dark:border-white/10"
                >
                  <Trash2 size={15} />
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
