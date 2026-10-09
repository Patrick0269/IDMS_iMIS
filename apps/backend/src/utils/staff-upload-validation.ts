const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_STAFF_UPLOAD_BYTES = 7 * 1024 * 1024;

const formats: Record<string, { mime: string; aliases: string[]; signature: (bytes: Buffer) => boolean }> = {
  pdf: { mime: "application/pdf", aliases: ["application/pdf"], signature: b => b.subarray(0, 5).toString("ascii") === "%PDF-" },
  jpg: { mime: "image/jpeg", aliases: ["image/jpeg", "image/jpg"], signature: b => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  jpeg: { mime: "image/jpeg", aliases: ["image/jpeg", "image/jpg"], signature: b => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  png: { mime: "image/png", aliases: ["image/png"], signature: b => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  doc: { mime: "application/msword", aliases: ["application/msword", "application/vnd.ms-word", "application/octet-stream"], signature: b => b.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) },
  docx: { mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", aliases: ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/zip", "application/octet-stream"], signature: b => b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && [0x03, 0x05, 0x07].includes(b[2]!) && [0x04, 0x06, 0x08].includes(b[3]!) },
};

export function validateStaffUpload(file: { fileName?: unknown; mimeType?: unknown; contentBase64?: unknown; documentType?: unknown }) {
  const name = String(file.fileName ?? "").replace(/[^\w. -]/g, "_").slice(0, 150);
  const extension = name.split(".").pop()?.toLowerCase() ?? "";
  const format = formats[extension];
  if (!format || !name.includes(".")) throw new Error("Use PDF, Word, JPEG or PNG");

  const encoded = String(file.contentBase64 ?? "");
  if (encoded.length > Math.ceil(MAX_FILE_BYTES / 3) * 4) throw new Error("Each file must be below 5 MB");
  if (!encoded || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw new Error("File data is not valid base64");
  }
  const bytes = Buffer.from(encoded, "base64");
  if (!bytes.length || bytes.length > MAX_FILE_BYTES || bytes.toString("base64") !== encoded) {
    throw new Error("Each file must be below 5 MB and contain valid base64 data");
  }

  const suppliedMime = String(file.mimeType ?? "").trim().toLowerCase();
  if (suppliedMime && !format.aliases.includes(suppliedMime)) throw new Error("File type does not match its extension");
  if (!format.signature(bytes)) throw new Error("File contents do not match the selected format");
  if (String(file.documentType ?? "").toUpperCase() === "PASSPORT" && !["jpg", "jpeg", "png"].includes(extension)) {
    throw new Error("Passport photo must be JPEG or PNG");
  }

  return { name, mimeType: format.mime, bytes };
}
