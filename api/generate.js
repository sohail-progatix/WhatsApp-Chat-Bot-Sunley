const pdfParse = require("pdf-parse");

function parseAmountFromInstruction(instruction) {
  const m = instruction.match(/\$?\s*([\d,]+(?:\.\d{1,2})?)/);
  if (m) {
    const num = parseFloat(m[1].replace(/,/g, ""));
    if (!isNaN(num) && num > 0)
      return num.toLocaleString("en-US", {minimumFractionDigits:0,maximumFractionDigits:0}) + "/-";
  }
  return null;
}

function fillTemplate(template, values) {
  return template.split("\n").map(line => {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) return line;
    const label = line.substring(0, colonIdx).trim().toUpperCase();
    if (values[label] && values[label].trim().length > 0)
      return line.substring(0, colonIdx + 1) + " " + values[label];
    return line;
  }).join("\n");
}

// ── Get value after a label, handling "LABEL : value" and "LABEL:\nvalue" ──
function getAfterLabel(lines, labelRegex) {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(labelRegex);
    if (m) {
      // Try inline value first (after the colon)
      const colonIdx = line.lastIndexOf(":");
      const inline = line.substring(colonIdx + 1).trim();
      if (inline.length > 1) return inline;
      // Otherwise next line
      if (i + 1 < lines.length) return lines[i + 1].trim();
    }
  }
  return null;
}

// ── Get lines after a section header until next section ──
function getLinesAfterHeader(lines, headerRegex, maxLines) {
  for (let i = 0; i < lines.length; i++) {
    if (headerRegex.test(lines[i])) {
      const result = [];
      for (let j = i + 1; j < lines.length && result.length < maxLines; j++) {
        const l = lines[j].trim();
        if (!l) continue;
        // Stop at next section header
        if (/^(Ship\s+to|Bill\s+to|Please\s+pay|Intermediate|BUYER|TOTAL|Pro.Forma|Page\s+\d)/i.test(l)) break;
        result.push(l);
      }
      return result;
    }
  }
  return [];
}

// ── Extract seller name & address ──
// Seller is the ISSUER of the invoice — found at BOTTOM of IFF-style PDFs
// or at TOP of BMJ-style PDFs (before BUYER:)
function extractSeller(lines) {
  // Strategy 1: Look for known seller patterns at bottom (IFF style)
  // IFF puts company name near end: "IFF (NEDERLAND) BV" then full name then address
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    // Skip page markers, totals, dates
    if (/^(Page|Total|Pro.Forma|All orders|Please|EXPORT|ATTENTION|FOR INVOICE)/i.test(line)) continue;
    if (/\d{4,}/.test(line) && !/[a-zA-Z]{3,}/.test(line)) continue; // pure numbers
    if (/@/.test(line)) continue;
    if (/^Phone|^VAT|^Chamber/i.test(line)) continue;

    // Found a company-like line near the bottom
    if (/[a-zA-Z]{3,}/.test(line) && line.length > 4) {
      // Now collect address lines after it
      const nameCandidate = line;
      const addrLines = [];
      for (let j = i + 1; j < lines.length && addrLines.length < 4; j++) {
        const al = lines[j].trim();
        if (!al) continue;
        if (/@/.test(al)) continue;
        if (/^Phone|^VAT|^Chamber|^Pro.Forma|^Page|^All orders/i.test(al)) break;
        if (/^\+\d/.test(al)) break; // phone
        addrLines.push(al);
      }
      if (addrLines.length > 0) {
        return { name: nameCandidate, address: addrLines.join(" ") };
      }
    }
  }

  // Strategy 2: Top of document before BUYER/BILL TO (BMJ style)
  const stopIdx = lines.findIndex(l => /^(BUYER|BILL\s+TO|TO\s*:|COMMERCIAL|PROFORMA|Pro.Forma)/i.test(l));
  const topLines = stopIdx > 0 ? lines.slice(0, stopIdx) : lines.slice(0, 8);

  let name = null;
  const addrLines = [];
  for (const line of topLines) {
    if (!line.trim()) continue;
    if (/^\d[\d\s\-\+\(\)]{4,}$/.test(line)) continue;
    if (/@/.test(line)) continue;
    if (/^Phone|^VAT|^Chamber/i.test(line)) continue;
    if (!name && /[a-zA-Z]{3,}/.test(line)) { name = line; continue; }
    if (name) addrLines.push(line);
  }
  if (name) return { name, address: addrLines.join(" ") };

  return { name: null, address: null };
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") { res.status(200).end(); return; }
  if (req.method !== "POST")    { res.status(405).json({ error: "Method not allowed" }); return; }

  const { pdfBase64, instruction, msgFormat } = req.body;
  if (!pdfBase64 || !instruction)
    return res.status(400).json({ error: "Missing pdfBase64 or instruction." });

  // ── Parse PDF ──
  let pdfText = "";
  try {
    const parsed = await pdfParse(Buffer.from(pdfBase64, "base64"));
    pdfText = parsed.text || "";
  } catch(e) {
    return res.status(500).json({ error: "Failed to parse PDF." });
  }

  // ── OCR for image headers (safe, non-crashing) ──
  let ocrText = "";
  try {
    const apiKey = process.env.OCR_API_KEY || "helloworld";
    const resp = await fetch("https://api.ocr.space/parse/image", {
      method: "POST",
      headers: { "apikey": apiKey, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        base64Image: "data:application/pdf;base64," + pdfBase64,
        language: "eng", isOverlayRequired: "false",
        filetype: "PDF", OCREngine: "2"
      }).toString()
    });
    const raw = await resp.text();
    try {
      const data = JSON.parse(raw);
      if (data?.ParsedResults?.[0]?.ParsedText) ocrText = data.ParsedResults[0].ParsedText;
    } catch(e) {}
  } catch(e) {}

  // OCR first (image headers), then pdf-parse text
  const combined = ocrText + "\n" + pdfText;
  const lines = combined.split("\n").map(l => l.trim()).filter(l => l.length > 0);

  // ── 1. BENEFICIARY NAME & ADDRESS (seller/issuer) ──
  const seller = extractSeller(lines);

  // ── 2. BANK NAME ──
  // "Please pay to" → next line is bank name (IFF style)
  // "BANK:" → value inline or next line (Sterling/BMJ style)
  let bankName =
    getAfterLabel(lines, /^Please\s+pay\s+to$/i) ||  // IFF style — next line
    getAfterLabel(lines, /^BANK\s*[:\-]/i) ||
    getAfterLabel(lines, /^Bank\s+[Nn]ame\s*[:\-]/i) ||
    null;

  // For IFF: "Please pay to" then next line = bank name
  const payToIdx = lines.findIndex(l => /^Please\s+pay\s+to$/i.test(l));
  if (payToIdx >= 0 && lines[payToIdx + 1]) {
    bankName = lines[payToIdx + 1].trim();
  }

  // ── 3. BANK ADDRESS ──
  // For IFF: bank name is on line after "Please pay to", 
  // but bank address is NOT present — just bank name + account + swift
  // For Sterling: ADDRESS: label
  let bankAddress = getAfterLabel(lines, /^ADDRESS\s*[:\-]/i) || null;
  if (bankAddress) bankAddress = bankAddress.replace(/\s*ABA\s*#.*$/i, "").replace(/,\s*$/, "").trim();

  // ── 4. ACCOUNT NUMBER ──
  // IFF: "Bank Account :988456353"
  // Sterling: "ACCOUNT # 0233683832"
  // BMJ: "Account Number : USD account: 1730002144278"
  let accountNo =
    getAfterLabel(lines, /^Bank\s+Account\s*[:\-]/i) ||
    getAfterLabel(lines, /^ACCOUNT\s*#\s*[:\-]?/i) ||
    getAfterLabel(lines, /^Account\s+Number\s*[:\-]/i) ||
    getAfterLabel(lines, /^Account\s+No\.?\s*[:\-]/i) ||
    null;

  // Clean "USD account: XXXX" pattern
  if (accountNo) {
    const m = accountNo.match(/(?:USD\s+account\s*[:\-]\s*)?([0-9]{6,20})/i);
    if (m) accountNo = m[1];
  }

  // ── 5. SWIFT ──
  // IFF: "Swift code :CHASUS33"
  // Sterling: "SWIFT: UPNBUS44"
  let swiftCode =
    getAfterLabel(lines, /^Swift\s+code\s*[:\-]/i) ||
    getAfterLabel(lines, /^SWIFT\s+CODE\s*[:\-]/i) ||
    getAfterLabel(lines, /^SWIFT\s*[:\-#]/i) ||
    getAfterLabel(lines, /^BIC\s*[:\-]/i) ||
    null;
  if (swiftCode) swiftCode = swiftCode.replace(/[^A-Z0-9]/gi, "").toUpperCase();

  // ── 6. INVOICE NUMBER ──
  // IFF: "Pro-Forma No. / Date : 9601231931 / 09.04.2026"
  // Sterling: "INVOICE #: 65117/65117A"
  // BMJ: "12022026-PMEL-R00"
  let invoiceNo =
    getAfterLabel(lines, /^INVOICE\s*#\s*[:\-]?/i) ||
    getAfterLabel(lines, /^Invoice\s+No\.?\s*[:\-]/i) ||
    getAfterLabel(lines, /^INV\s*#\s*[:\-]?/i) ||
    null;

  // IFF Pro-Forma style: "Pro-Forma No. / Date : 9601231931 / 09.04.2026"
  if (!invoiceNo) {
    const proFormaLine = lines.find(l => /Pro.Forma\s+No\.?\s*[\/\s]*Date\s*:/i.test(l));
    if (proFormaLine) {
      const m = proFormaLine.match(/:\s*([0-9]+)\s*\//);
      if (m) invoiceNo = m[1];
    }
  }

  // Clean invoice: take only the number part before extra slashes/dates
  if (invoiceNo) {
    invoiceNo = invoiceNo.split("/")[0].trim();
  }

  // ── 7. PURPOSE ──
  let purpose = null;
  const purposeKeywords = [
    /PERFUME\s+COMPOUND/i, /WASTE\s+PAPER/i, /CIGARETTE\s+PAPER/i,
    /CORK\s+TIPPING/i, /TEXTILE/i, /FRAGRANCE/i
  ];
  for (const line of lines) {
    for (const kw of purposeKeywords) {
      if (kw.test(line)) {
        // Clean the line — remove numbers, KG, prices
        purpose = line.replace(/\d+[\.,]?\d*\s*(KG|MT|PCS|USD|US\$)?/gi, "").replace(/\s+/g, " ").trim();
        if (purpose.length > 3) break;
      }
    }
    if (purpose) break;
  }
  if (!purpose) purpose = getAfterLabel(lines, /^Purpose\s*[:\-]/i) || "IMPORT OF GOODS";

  // ── 8. AMOUNT — always from instruction only ──
  const amount = parseAmountFromInstruction(instruction);

  // ── Build values ──
  const clean = s => s ? s.replace(/,\s*$/,"").replace(/\s+/g," ").trim().toUpperCase() : null;

  const values = {};
  if (seller.name)    values["BENEFICIARY NAME"]         = clean(seller.name);
  if (seller.address) values["BENEFICIARY ADDRESS"]      = clean(seller.address);
  if (bankName)       values["BENEFICIARY BANK NAME"]    = clean(bankName);
  if (bankAddress)    values["BENEFICIARY BANK ADDRESS"] = clean(bankAddress);
  if (accountNo)      values["BENEFICIARY A/C NO"]       = accountNo.trim();
  if (swiftCode)      values["SWIFT CODE"]               = swiftCode;
  if (invoiceNo)      values["INVOICE NO"]               = invoiceNo.trim().toUpperCase();
  if (purpose)        values["PURPOSE"]                  = clean(purpose);
  if (amount)         values["AMOUNT USD"]               = amount;

  if (msgFormat && msgFormat.trim().length > 0) {
    return res.status(200).json({ text: fillTemplate(msgFormat, values).trim() });
  }

  const outLines = Object.entries(values).map(([k,v]) => k + ": " + v);
  return res.status(200).json({ text: outLines.join("\n\n") });
};
