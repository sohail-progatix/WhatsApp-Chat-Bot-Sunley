const pdfParse = require("pdf-parse");

function extract(text, patterns) {
  for (const pattern of patterns) {
    const m = text.match(new RegExp(pattern, "i"));
    if (m) {
      const val = (m[1] || m[0]).trim().replace(/\s+/g, " ");
      if (val.length > 1) return val;
    }
  }
  return null;
}

function parseAmountFromInstruction(instruction) {
  const m = instruction.match(/\$?\s*([\d,]+(?:\.\d{1,2})?)/);
  if (m) {
    const num = parseFloat(m[1].replace(/,/g, ""));
    if (!isNaN(num) && num > 0) {
      return num.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 }) + "/-";
    }
  }
  return null;
}

function fillTemplate(template, values) {
  return template.split("\n").map(line => {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) return line;
    const label = line.substring(0, colonIdx).trim().toUpperCase();
    if (values[label] && values[label].trim().length > 0) {
      return line.substring(0, colonIdx + 1) + " " + values[label];
    }
    return line;
  }).join("\n");
}

// ── Smart section splitter ──
// Splits PDF into: sellerSection, bodySection, bankSection
function splitPDFSections(text) {
  const normalized = text.replace(/\r\n/g, "\n");

  // Find where BUYER section starts — everything before is seller info
  const buyerIdx = normalized.search(/\bBUYER\s*[:\-]/i);
  const sellerSection = buyerIdx > 0 ? normalized.substring(0, buyerIdx) : normalized.substring(0, 300);

  // Find where BANK section starts — bank details are here
  const bankIdx = normalized.search(/\bBANK\s*[:\-]/i);
  const bankSection = bankIdx > 0 ? normalized.substring(bankIdx) : "";

  // Body section (between buyer and bank)
  const bodySection = normalized;

  return { sellerSection, bankSection, bodySection };
}

// ── Extract seller name: first meaningful line in seller section ──
function extractSellerName(sellerSection) {
  const lines = sellerSection.split("\n").map(l => l.trim()).filter(l => l.length > 3);
  for (const line of lines) {
    // Skip lines that look like addresses (have numbers at start) or phone numbers or emails
    if (/^\d/.test(line)) continue;
    if (/@/.test(line)) continue;
    if (/^[\d\s\-\+\(\)]+$/.test(line)) continue;
    if (/INVOICE|DATE|REVISION|PROFORMA|COMMERCIAL/i.test(line)) continue;
    // Must look like a company name
    if (line.length >= 4 && /[a-zA-Z]/.test(line)) {
      return line;
    }
  }
  return null;
}

// ── Extract seller address: address lines after company name ──
function extractSellerAddress(sellerSection) {
  const lines = sellerSection.split("\n").map(l => l.trim()).filter(l => l.length > 3);
  const addrLines = [];
  let foundName = false;

  for (const line of lines) {
    if (!foundName) {
      // Skip until we find the company name line
      if (!/^\d/.test(line) && !/@/.test(line) && /[a-zA-Z]/.test(line) &&
          !/INVOICE|DATE|REVISION/i.test(line)) {
        foundName = true;
      }
      continue;
    }
    // Stop collecting at email, phone-only lines, or document keywords
    if (/@/.test(line)) break;
    if (/COMMERCIAL|PROFORMA|INVOICE|DATE/i.test(line)) break;
    if (/^[\d\s\-\+\(\)]+$/.test(line)) break;

    addrLines.push(line);
    // Usually address is 2-4 lines
    if (addrLines.length >= 4) break;
  }
  return addrLines.length > 0 ? addrLines.join(" ") : null;
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

  // ── Parse PDF ──
  let pdfText = "";
  try {
    const buf = Buffer.from(pdfBase64, "base64");
    const parsed = await pdfParse(buf);
    pdfText = parsed.text || "";
  } catch (err) {
    return res.status(500).json({ error: "Failed to parse PDF: " + err.message });
  }

  if (pdfText.trim().length < 20) {
    return res.status(400).json({ error: "Could not extract text from this PDF." });
  }

  const { sellerSection, bankSection, bodySection } = splitPDFSections(pdfText);

  // ── Extract fields ──

  // Seller name — from top of document before BUYER
  const beneficiaryName = extractSellerName(sellerSection);

  // Seller address — lines after company name before BUYER
  const beneficiaryAddress = extractSellerAddress(sellerSection);

  // Bank name — from BANK section
  const bankName = extract(bankSection, [
    "BANK\\s*[:\\-]\\s*([^\\n]{3,60})",
    "Bank\\s+[Nn]ame\\s*[:\\-]\\s*([^\\n]{3,60})",
    "([A-Z][A-Za-z\\s]+BANK[^\\n]{0,20})",
  ]);

  // Bank address — from ADDRESS after BANK
  const bankAddress = extract(bankSection, [
    "ADDRESS\\s*[:\\-]\\s*([^\\n]{5,80}(?:\\n[^:\\n]{3,60}){0,3})",
  ]);

  // Account number
  const accountNo = extract(bankSection + "\n" + bodySection, [
    "ACCOUNT\\s*#\\s*[:\\-]?\\s*([0-9]{6,20})",
    "Account\\s+(?:No\\.?|Number|#)\\s*[:\\-]?\\s*(?:USD\\s+account[:\\-]+\\s*)?([0-9]{6,20})",
    "A\\/C\\s*(?:No\\.?|#)?\\s*[:\\-]?\\s*([0-9]{6,20})",
  ]);

  // SWIFT
  const swiftCode = extract(bankSection + "\n" + bodySection, [
    "SWIFT\\s*[:\\-#]?\\s*([A-Z0-9]{6,11})",
    "Swift\\s+[Cc]ode\\s*[:\\-]?\\s*([A-Z0-9]{6,11})",
    "BIC\\s*[:\\-]?\\s*([A-Z0-9]{6,11})",
  ]);

  // Invoice number
  const invoiceNo = extract(bodySection, [
    "INVOICE\\s*#\\s*[:\\-]?\\s*([A-Z0-9\\/\\-]{3,30})",
    "Invoice\\s+(?:No\\.?|Number|#)\\s*[:\\-]?\\s*([A-Z0-9\\/\\-]{3,30})",
  ]);

  // Purpose — from goods description
  const purpose = extract(bodySection, [
    "Purpose\\s*[:\\-]\\s*([^\\n]{5,80})",
    "(WASTE\\s+PAPER[^\\n]{0,40})",
    "(CIGARETTE\\s+PAPER[^\\n]{0,40})",
    "(CORK\\s+TIPPING[^\\n]{0,40})",
    "(?:PARTICULARS|DESCRIPTION)[^\\n]*\\n+([^\\n]{5,80})",
  ]) || "IMPORT OF GOODS";

  // Amount — instruction first, then PDF
  const amountFromInstr = parseAmountFromInstruction(instruction);
  const amountFromPDF   = extract(bodySection, [
    "TOTAL\\s+US\\$\\s*([0-9,]+(?:\\.[0-9]{2})?)",
    "TOTAL\\s*\\$?\\s*([0-9,]+(?:\\.[0-9]{2})?)",
    "\\$\\s*([0-9,]{4,12}(?:\\.[0-9]{2})?)",
  ]);
  const amount = amountFromInstr || (amountFromPDF ? amountFromPDF + "/-" : null);

  // ── Build values map ──
  const values = {};
  if (beneficiaryName)    values["BENEFICIARY NAME"]         = beneficiaryName.toUpperCase().replace(/[,\.]+$/, "");
  if (beneficiaryAddress) values["BENEFICIARY ADDRESS"]      = beneficiaryAddress.toUpperCase().replace(/[,]+$/, "").replace(/,\s*/g, " ");
  if (bankName)           values["BENEFICIARY BANK NAME"]    = bankName.toUpperCase().replace(/[,\.]+$/, "");
  if (bankAddress)        values["BENEFICIARY BANK ADDRESS"] = bankAddress.toUpperCase().replace(/\n/g, " ").replace(/,\s*/g, " ").replace(/\s+/g, " ").trim();
  if (accountNo)          values["BENEFICIARY A/C NO"]       = accountNo;
  if (swiftCode)          values["SWIFT CODE"]               = swiftCode.toUpperCase();
  if (invoiceNo)          values["INVOICE NO"]               = invoiceNo.toUpperCase();
  if (purpose)            values["PURPOSE"]                  = purpose.toUpperCase();
  if (amount)             values["AMOUNT USD"]               = amount;

  // ── Fill template or return structured output ──
  if (msgFormat && msgFormat.trim().length > 0) {
    const filled = fillTemplate(msgFormat, values);
    return res.status(200).json({ text: filled.trim() });
  }

  const lines = Object.entries(values).map(([k, v]) => k + ": " + v);
  return res.status(200).json({ text: lines.join("\n\n") });
};
