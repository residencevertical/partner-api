/**
 * Minimal, hand-built one-page PDF — MOCK ONLY (throw this file away).
 *
 * The real `GET /api/partner/v1/reports/{id}/pdf` returns the actual multi-page
 * ResidenceVertical report (a few megabytes, images included). This builder exists so the
 * local mock answers with bytes that are a genuinely valid PDF: `%PDF-` header, correct
 * cross-reference table offsets, `%%EOF` — so it opens in any viewer and your download /
 * proxy / storage code is exercised for real.
 *
 * Zero dependencies: the file is assembled by hand and the xref offsets are measured on the
 * concatenated bytes.
 */

/** Latin-1/ASCII fold — Helvetica's default encoding has no ă/î/ș/ț glyphs. */
function toPdfAscii(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^\x20-\x7E]/g, "");
}

/** PDF literal-string escaping: backslash and both parentheses. */
function escapePdfText(value) {
  return toPdfAscii(value).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

/**
 * @param {{title: string, lines: string[], footer?: string}} content
 * @returns {Buffer} a complete, valid single-page A4 PDF
 */
export function buildMinimalPdf({ title, lines = [], footer = "" }) {
  const body = lines.map((line) => `(${escapePdfText(line)}) Tj T*`).join("\n");
  const stream = [
    "0.5 w 60 776 m 535 776 l S",
    "BT /F1 18 Tf 60 792 Td (" + escapePdfText(title) + ") Tj ET",
    "BT /F1 11 Tf 60 750 Td 17 TL",
    body,
    "ET",
    "BT /F1 9 Tf 60 60 Td (" + escapePdfText(footer) + ") Tj ET",
  ].join("\n");

  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] "
      + "/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`,
  ];

  // Header: the binary comment line marks the file as containing 8-bit data (PDF 1.7 §7.5.2).
  const chunks = [Buffer.from("%PDF-1.4\n", "latin1"), Buffer.from("%\xE2\xE3\xCF\xD3\n", "latin1")];
  const offsets = [];
  let offset = chunks.reduce((total, chunk) => total + chunk.length, 0);

  objects.forEach((object, index) => {
    const chunk = Buffer.from(`${index + 1} 0 obj\n${object}\nendobj\n`, "latin1");
    offsets.push(offset);
    offset += chunk.length;
    chunks.push(chunk);
  });

  const startxref = offset;
  const entries = [
    "0000000000 65535 f \n",
    ...offsets.map((value) => `${String(value).padStart(10, "0")} 00000 n \n`),
  ].join("");
  chunks.push(Buffer.from(
    `xref\n0 ${objects.length + 1}\n${entries}`
    + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${startxref}\n%%EOF\n`,
    "latin1",
  ));

  return Buffer.concat(chunks);
}
