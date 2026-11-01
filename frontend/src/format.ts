const bytes = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
export function formatSize(n: number) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = n > 0 ? Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1) : 0;
  return `${bytes.format(n / 1024 ** i)} ${units[i]}`;
}

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
export function timeAgo(iso: string) {
  const s = (new Date(iso).getTime() - Date.now()) / 1000;
  for (const [unit, secs] of [["day", 86400], ["hour", 3600], ["minute", 60]] as const) {
    if (Math.abs(s) >= secs) return rtf.format(Math.round(s / secs), unit);
  }
  return "just now";
}
