const signatures: Record<string, (bytes: Buffer) => boolean> = {
  "application/pdf": bytes => bytes.subarray(0, 5).toString("ascii") === "%PDF-",
  "image/jpeg": bytes => bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
  "image/png": bytes => bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  "image/webp": bytes => bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP",
};

export function privateDocumentMatchesMime(bytes: unknown, mimeType: string): boolean {
  if (!Buffer.isBuffer(bytes)) return false;
  const check = signatures[mimeType.trim().toLowerCase()];
  return Boolean(check && check(bytes));
}
