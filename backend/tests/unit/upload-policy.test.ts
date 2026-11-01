import { HttpError } from "../../src/errors";
import { checkUpload, sanitizeFilename, sniffContentType } from "../../src/upload-policy";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0]);
const EXE = Buffer.from("MZ\x90\x00", "latin1");
const TEXT = Buffer.from("hello world");

describe("sanitizeFilename", () => {
  it.each([
    ["../../etc/passwd", "passwd"],
    ["C:\\Users\\me\\report.pdf", "report.pdf"],
    ["  notes.txt  ", "notes.txt"],
    ["bad\u0000name\u0007.txt", "badname.txt"],
    ["invoice\u202Etxt.exe", "invoicetxt.exe"], // right-to-left override removed
    ["..", "unnamed"],
    ["", "unnamed"],
    [".bashrc", ".bashrc"], // hidden files are fine; only path tricks are removed
    ["e\u0301te.txt", "\u00e9te.txt"], // NFC: decomposed é becomes one code point
  ])("%j → %j", (input, expected) => {
    expect(sanitizeFilename(input)).toBe(expected);
  });

  it("clips to 255 bytes without breaking characters and keeps the extension", () => {
    const name = sanitizeFilename("日".repeat(200) + ".pdf");
    expect(Buffer.byteLength(name)).toBeLessThanOrEqual(255);
    expect(name.endsWith(".pdf")).toBe(true);
    expect(name).not.toContain("\uFFFD"); // no half-characters
  });
});

describe("sniffContentType", () => {
  it("recognises formats by their first bytes", () => {
    expect(sniffContentType(PNG)).toBe("image/png");
    expect(sniffContentType(Buffer.from("%PDF-1.7"))).toBe("application/pdf");
    expect(sniffContentType(TEXT)).toBeUndefined();
  });
});

describe("checkUpload", () => {
  it("stores the sniffed type, not the client's claim", () => {
    expect(checkUpload("cat.png", PNG, "text/plain")).toBe("image/png");
  });

  it("keeps the claim when content has no known signature", () => {
    expect(checkUpload("a.csv", TEXT, "text/csv")).toBe("text/csv");
  });

  it("downgrades types a browser would execute to octet-stream", () => {
    expect(checkUpload("page.html", TEXT, "text/html")).toBe("application/octet-stream");
    expect(checkUpload("logo.svg", TEXT, "image/svg+xml")).toBe("application/octet-stream");
    expect(checkUpload("x", TEXT, "")).toBe("application/octet-stream");
  });

  it("trusts a specific Office type over a generic zip signature", () => {
    const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
    const docx = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    expect(checkUpload("a.docx", zip, docx)).toBe(docx);
  });

  it.each([
    ["by extension", "setup.EXE", TEXT],
    ["by content, even when renamed", "holiday.jpg", EXE],
    ["ELF binary", "tool", Buffer.from([0x7f, 0x45, 0x4c, 0x46])],
  ])("rejects executables %s with 415", (_label, name, head) => {
    expect(() => checkUpload(name, head, "application/octet-stream")).toThrow(
      expect.objectContaining({ status: 415 }) as unknown as HttpError,
    );
  });
});
