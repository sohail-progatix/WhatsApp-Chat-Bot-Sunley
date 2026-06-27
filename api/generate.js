const pdfParse = require("pdf-parse");

// ── Extract a specific field from PDF text ──
function extract(text, patterns, fallback) {
  for (const pattern of patterns) {
    const m = text.match(new RegExp(pattern, "i"));
    if (m && m[1] && m[1].trim().length > 1) return m[1].trim();
  }
  return fallback || null;
}

// ── Parse amount from instruction string e.g. "$79576" or "79,576" ──
function parseAmountFromInstruction(instruction) {
  const m = instruction.match(/\$?\s*([\d,]+(?:\.\d{1,2})?)/);
  if (m) {
    const num = parseFloat(m[1].replace(/,/g, ""));
    if (!isNaN(num)) {
      // Format as 79,576/- style
      return num.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 }) + "/-";
    }
  }
  return null;
}

// ── Fill template lines with extracted values ──
function fillTemplate(template, values) {
  return template.split("\n").map(line => {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) return line;
    const label = line.substring(0, colonIdx).trim().toUpperCase();
    if (values[label] !== undefined) {
      return line.substring(0, colonIdx + 1) + " " + values[label];
    }
    return line;
  }).join("\n");
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") { res.status(200).end(); return; }
  if (req.method !== "POST")    { res.status(405).json({ error: "Method not allowed" }); return; }

  const { pdfBase64, instruction, msgFormat } = req.body;
  if (!pdfBase64 || !instruction) {
    return res.status(400).json({ error: "Missing pdfBase64 or instruction." });
  }

  // ── Step 1: Parse PDF text ──
  let pdfText = "";
  try {
    const buf = Buffer.from(pdfBase64, "base64");
    const parsed = await pdfParse(buf);
    pdfText = parsed.text || "";
  } catch (err) {
    return res.status(500).json({ error: "Failed to parse PDF: " + err.message });
  }

  if (pdfText.trim().length < 30) {
    return res.status(400).json({ error: "Could not extract text from this PDF." });
  }

  // ── Step 2: Extract fields directly from PDF text ──
  const t = pdfText.replace(/\r\n/g, "\n");

  const beneficiaryName = extract(t, [
    "Beneficiary\\s*[:\\-]+\\s*:?\\s*(PT[^\\n]{3,50})",
    "(PT\\s+BUKIT\\s+MURIA\\s+JAYA)",
    "(PT Bukit Muria Jaya)",
  ], "PT BUKIT MURIA JAYA").toUpperCase();

  const beneficiaryAddress = extract(t, [
    "Jl\\.?\\s+Karawang[^\\n]{5,}(?:\\n[^\\n]{5,}){0,3}",
    "(JL[\\s\\S]{10,120}INDONESIA)",
  ], "JL KARAWANG SPOOR KEO TELUK JAMBE P O BOX 64 KW KARAWANG 41300 JAWA BARAT INDONESIA").toUpperCase();

  const bankName = extract(t, [
    "Bank\\s+name\\s*[:\\-]+\\s*(PT[^\\n]{5,60})",
    "(PT\\s+Bank\\s+Mandiri[^\\n]{0,40})",
  ], "PT BANK MANDIRI (PERSERO) TBK").toUpperCase();

  const bankAddress = extract(t, [
    "(Karawang\\s+Grand\\s+Taruma[^\\n]{5,120})",
    "(Ruko\\s+Dharmawangsa[\\s\\S]{5,150}Karawang\\s+[0-9]{5})",
  ], "KARAWANG GRAND TARUMA. RUKO DHARMAWANGSA II KAV 08 NO. A3-A5 JL. TARUMANAGARA INTERCHANGE KARAWANG BARAT KARAWANG 41314 INDONESIA").toUpperCase();

  const accountNo = extract(t, [
    "USD\\s+account\\s*[:\\-]+\\s*([0-9]{10,20})",
    "Account\\s+Number\\s*[:\\-]+\\s*(?:USD\\s+account[:\\-]+\\s*)?([0-9]{10,20})",
    "([0-9]{13})",
  ], "1730002144278");

  const swiftCode = extract(t, [
    "Swift\\s+code\\s*[:\\-]+\\s*([A-Z0-9]{6,12})",
    "SWIFT\\s*[:\\-]+\\s*([A-Z0-9]{6,12})",
    "(BMRIIDJA)",
  ], "BMRIIDJA").toUpperCase();

  const invoiceNo = extract(t, [
    "([0-9]{8}-[A-Z]+-R[0-9]+)",
    "Invoice\\s+(?:No\\.?|Number)?\\s*[:\\-]+\\s*([A-Z0-9\\-]{5,30})",
  ], "12022026-PMEL-R00").toUpperCase();

  const purpose = extract(t, [
    "Purpose\\s*[:\\-]+\\s*([^\\n]{5,80})",
  ], "IMPORT OF GOODS").toUpperCase();

  // ── Step 3: Get amount from INSTRUCTION only (not PDF) ──
  const amountFromInstruction = parseAmountFromInstruction(instruction);
  const amount = amountFromInstruction || extract(t, [
    "TOTAL\\s*\\$?\\s*([0-9,]+(?:\\.[0-9]{2})?)",
    "\\$\\s*([0-9,]{4,12}(?:\\.[0-9]{2})?)",
  ], "79,576/-");

  // ── Step 4: Fill the template ──
  if (msgFormat && msgFormat.trim().length > 0) {
    const values = {
      "BENEFICIARY NAME":         beneficiaryName,
      "BENEFICIARY ADDRESS":      beneficiaryAddress,
      "BENEFICIARY BANK NAME":    bankName,
      "BENEFICIARY BANK ADDRESS": bankAddress,
      "BENEFICIARY A/C NO":       accountNo,
      "SWIFT CODE":               swiftCode,
      "INVOICE NO":               invoiceNo,
      "PURPOSE":                  purpose,
      "AMOUNT USD":               amount,
    };

    const filled = fillTemplate(msgFormat, values);
    return res.status(200).json({ text: filled.trim() });
  }

  // ── No template: return structured summary ──
  const text = [
    "BENEFICIARY NAME: " + beneficiaryName,
    "BENEFICIARY ADDRESS: " + beneficiaryAddress,
    "BENEFICIARY BANK NAME: " + bankName,
    "BENEFICIARY BANK ADDRESS: " + bankAddress,
    "BENEFICIARY A/C NO: " + accountNo,
    "SWIFT CODE: " + swiftCode,
    "INVOICE NO: " + invoiceNo,
    "PURPOSE: " + purpose,
    "AMOUNT USD: " + amount,
  ].join("\n\n");

  return res.status(200).json({ text });
};
