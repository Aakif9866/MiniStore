import path from "node:path";
import { HttpError } from "./errors";

// ---------- Filenames ----------
// The name is display-only (we generate object keys), but it still ends up in the UI, in
// Content-Disposition headers and on users' disks when they download. Clean it once, on the way in.

const UNSAFE_CHARS = /[\u0000-\u001f\u007f‪-‮⁦-⁩]/g; // control chars + bidi overrides
const MAX_NAME_BYTES = 255; // what most filesystems allow

export function sanitizeFilename(raw: string): string {
  let name = raw
    .normalize("NFC") // "é" typed two ways becomes one form, so search and dedupe behave
    .replace(UNSAFE_CHARS, "") // bidi overrides can make "cod.exe" display as "exe.doc"
    .split(/[/\\]/)
    .pop()!
    .trim();
  if (name === "." || name === "..") name = "";
  return clipBytes(name, MAX_NAME_BYTES) || "unnamed";
}

/** Shorten to `max` UTF-8 bytes without splitting a character, keeping the extension. */
function clipBytes(name: string, max: number): string {
  if (Buffer.byteLength(name) <= max) return name;
  const ext = path.extname(name);
  const keepExt = Buffer.byteLength(ext) <= 20 ? ext : "";
  const stem = Array.from(name.slice(0, name.length - keepExt.length));
  while (Buffer.byteLength(stem.join("") + keepExt) > max) stem.pop();
  return stem.join("") + keepExt;
}

// ---------- Content type ----------
// The client's Content-Type is a claim, not a fact. The first bytes of the file are a fact.

// ponytail: a small magic-number table covers the common formats; swap in libmagic/file-type
// if accurate labelling of many formats starts to matter.
const SIGNATURES: [type: string, offset: number, bytes: number[]][] = [
  ["image/png", 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  ["image/jpeg", 0, [0xff, 0xd8, 0xff]],
  ["image/gif", 0, [0x47, 0x49, 0x46, 0x38]],
  ["image/webp", 8, [0x57, 0x45, 0x42, 0x50]],
  ["application/pdf", 0, [0x25, 0x50, 0x44, 0x46, 0x2d]],
  ["application/zip", 0, [0x50, 0x4b, 0x03, 0x04]],
  ["application/gzip", 0, [0x1f, 0x8b]],
  ["video/mp4", 4, [0x66, 0x74, 0x79, 0x70]],
];

const EXECUTABLE_SIGNATURES = [
  [0x4d, 0x5a], // MZ: Windows .exe/.dll
  [0x7f, 0x45, 0x4c, 0x46], // ELF: Linux binaries
  [0xcf, 0xfa, 0xed, 0xfe], // Mach-O 64-bit (macOS)
  [0xce, 0xfa, 0xed, 0xfe], // Mach-O 32-bit
  [0xca, 0xfe, 0xba, 0xbe], // Mach-O universal (also Java .class)
];

// Roughly the list mail providers block: things that run when double-clicked.
const BLOCKED_EXTENSIONS = new Set(
  ".exe .dll .msi .scr .com .bat .cmd .ps1 .vbs .vbe .js .jse .wsf .wsh .hta .cpl .jar .app .pkg .dmg .apk .lnk"
    .split(" "),
);

// Types a browser would render or execute if it ever opened the file inline.
const ACTIVE_TYPES = /^(text\/html|application\/xhtml\+xml|image\/svg\+xml|text\/xml|application\/xml|text\/javascript|application\/javascript)/;

/** Bytes needed by sniffContentType. */
export const SNIFF_BYTES = 16;

const startsWith = (head: Buffer, offset: number, sig: number[]) =>
  sig.every((b, i) => head[offset + i] === b);

export function sniffContentType(head: Buffer): string | undefined {
  return SIGNATURES.find(([, offset, sig]) => startsWith(head, offset, sig))?.[0];
}

/**
 * Decide whether an upload is allowed and what Content-Type to store.
 * Throws 415 for executables, judged by BOTH name and content, so renaming doesn't help.
 */
export function checkUpload(name: string, head: Buffer, claimedType: string): string {
  if (BLOCKED_EXTENSIONS.has(path.extname(name).toLowerCase()) ||
      EXECUTABLE_SIGNATURES.some((sig) => startsWith(head, 0, sig))) {
    throw new HttpError(415, "Executable files are not allowed");
  }
  const sniffed = sniffContentType(head);
  // .docx/.xlsx/.epub are zip files underneath: trust the more specific claim.
  if (sniffed === "application/zip" && /^application\/(vnd\.|epub)/.test(claimedType)) return claimedType;
  if (sniffed) return sniffed;
  if (!claimedType || ACTIVE_TYPES.test(claimedType)) return "application/octet-stream";
  return claimedType;
}
