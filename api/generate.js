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

function getAfterLabel(lines, labelRegex) {
  for (let i = 0; i < lines.length; i++) {
    if (labelRegex.test(lines[i])) {
      const colonIdx = lines[i].lastIndexOf(":");
      const inline = lines[i].substring(colonIdx + 1).trim();
      if (inline.length > 1) return inline;
      if (i + 1 < lines.length) return lines[i + 1].trim();
    }
  }
  return null;
}

// ── SELLER EXTRACTION — handles 3 invoice layouts ──
function extractSeller(lines) {

  // ── LAYOUT A: IFF style ──
  // Seller block appears AFTER "Pro Forma Invoice Page X of Y" line
  // Structure: "IFF (NEDERLAND) BV" (short id) → "International Flavors..." (full name) → address
  const pageMarkerIdx = lines.findIndex(l =>
    /Pro\s*Forma\s+Invoice\s+Page\s+\d/i.test(l) ||
    /^Page\s+\d+\s+of\s+\d+/i.test(l)
  );

  if (pageMarkerIdx >= 0) {
    const afterPage = lines.slice(pageMarkerIdx + 1);
    let name = null;
    const addrLines = [];

    for (let i = 0; i < afterPage.length; i++) {
      const line = afterPage[i].trim();
      if (!line) continue;
      if (/^(Chamber|Phone|VAT|Tax|Reg|Total|Freight|EXPORT|ATTENTION|FOR INVOICE|Pro.Forma\s+No)/i.test(line)) break;
      if (/^\+\d/.test(line)) break;
      if (/@/.test(line)) break;

      if (!name) {
        // If line is short all-caps (letterhead id like "IFF (NEDERLAND) BV")
        // use the NEXT line as the full legal name
        if (/^[A-Z0-9\s\(\)\.&\-]{3,30}$/.test(line) && i + 1 < afterPage.length) {
          const nextLine = afterPage[i + 1].trim();
          if (/[a-z]/.test(nextLine)) { // full name has mixed case
            name = nextLine;
            i++; // skip next line
          } else {
            name = line;
          }
        } else {
          name = line;
        }
        continue;
      }
      addrLines.push(line);
      if (addrLines.length >= 3) break;
    }
    if (name && addrLines.length > 0) {
      return { name: name.trim(), address: addrLines.join(" ") };
    }
  }

  // ── LAYOUT B: BMJ style ──
  // Seller at TOP before "TO :" or "BUYER:" or "Pro-Forma No"
  const stopPatterns = /^(BUYER|BILL\s+TO|TO\s*:|COMMERCIAL\s+INVOICE|PROFORMA|Pro.Forma\s+No|Line\s+Material|DATE\s*:)/i;
  const stopIdx = lines.findIndex(l => stopPatterns.test(l));
  const topLines = stopIdx > 2 ? lines.slice(0, stopIdx) : [];

  if (topLines.length > 0) {
    let name = null;
    const addrLines = [];
    for (const line of topLines) {
      if (/^\d[\d\s\-\+\(\)]{4,}$/.test(line)) continue;
      if (/@/.test(line)) continue;
      if (/^(Phone|VAT|Chamber|Reg)/i.test(line)) continue;
      if (!name && /[a-zA-Z]{3,}/.test(line)) { name = line; continue; }
      if (name) addrLines.push(line);
    }
    if (name && addrLines.length > 0) return { name, address: addrLines.join(" ") };
  }

  // ── LAYOUT C: OCR image header (Sterling style) ──
  // OCR gives us the company name as first lines
  for (let i = 0; i < Math.min(lines.length, 12); i++) {
    const line = lines[i];
    if (/^\d/.test(line)) continue;
    if (/@/.test(line)) continue;
    if (/^(COMMERCIAL|PROFORMA|INVOICE|DATE|BUYER|BILL|TO\s*:|Page|Pro.Forma)/i.test(line)) continue;
    if (/[a-zA-Z]{4,}/.test(line) && line.length > 5) {
      const addrLines = [];
      for (let j = i + 1; j < lines.length && addrLines.length < 4; j++) {
        const al = lines[j].trim();
        if (!al) continue;
        if (/^(COMMERCIAL|PROFORMA|INVOICE|DATE|BUYER|BILL|TO\s*:|Page|Pro.Forma)/i.test(al)) break;
        if (/@/.test(al)) break;
        if (/^\d[\d\s\-\+]{5,}$/.test(al)) break;
        addrLines.push(al);
      }
      if (addrLines.length > 0) return { name: line, address: addrLines.join(" ") };
    }
  }

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

  // ── OCR for image-based headers ──
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

  // OCR first, then pdf-parse
  const combined = ocrText + "\n" + pdfText;
  const lines = combined.split("\n").map(l => l.trim()).filter(l => l.length > 0);

  // ── Extract fields ──

  // 1. Seller
  const seller = extractSeller(lines);

  // 2. Bank name
  let bankName = null;
  const payToIdx = lines.findIndex(l => /^Please\s+pay\s+to\s*$/i.test(l));
  if (payToIdx >= 0 && lines[payToIdx + 1]) {
    bankName = lines[payToIdx + 1].trim();
  } else {
    bankName = getAfterLabel(lines, /^BANK\s*[:\-]/i) ||
               getAfterLabel(lines, /^Bank\s+[Nn]ame\s*[:\-]/i) || null;
  }

  // 3. Bank address
  let bankAddress = getAfterLabel(lines, /^ADDRESS\s*[:\-]/i) || null;
  if (bankAddress) bankAddress = bankAddress.replace(/\s*ABA\s*#.*$/i,"").replace(/,\s*$/,"").trim();

  // 4. Account number
  let accountNo =
    getAfterLabel(lines, /^Bank\s+Account\s*[:\-]/i) ||
    getAfterLabel(lines, /^ACCOUNT\s*#\s*/i) ||
    getAfterLabel(lines, /^Account\s+Number\s*[:\-]/i) ||
    getAfterLabel(lines, /^A\/C\s*(?:No\.?)?\s*[:\-]/i) || null;
  if (accountNo) {
    const m = accountNo.match(/([0-9]{6,20})/);
    if (m) accountNo = m[1];
  }

  // 5. SWIFT
  let swiftCode =
    getAfterLabel(lines, /^Swift\s+code\s*[:\-]/i) ||
    getAfterLabel(lines, /^SWIFT\s+CODE\s*[:\-]/i) ||
    getAfterLabel(lines, /^SWIFT\s*[:\-#]/i) ||
    getAfterLabel(lines, /^BIC\s*[:\-]/i) || null;
  if (swiftCode) swiftCode = swiftCode.replace(/[^A-Z0-9]/gi,"").toUpperCase();

  // 6. Invoice number
  let invoiceNo =
    getAfterLabel(lines, /^INVOICE\s*#\s*/i) ||
    getAfterLabel(lines, /^Invoice\s+No\.?\s*[:\-]/i) ||
    getAfterLabel(lines, /^INV\s*#\s*/i) || null;

  if (!invoiceNo) {
    const proLine = lines.find(l => /Pro.Forma\s+No\.?.*Date\s*:/i.test(l));
    if (proLine) {
      const m = proLine.match(/:\s*([0-9]{5,})\s*\//);
      if (m) invoiceNo = m[1];
    }
  }
  if (invoiceNo) invoiceNo = invoiceNo.split("/")[0].trim();

  // 7. Purpose
  let purpose = null;
  const goodsPatterns = [
    /PERFUME\s+COMPOUND/i, /WASTE\s+PAPER/i, /CIGARETTE\s+PAPER/i,
    /CORK\s+TIPPING/i, /FRAGRANCE/i, /TEXTILE/i, /CHEMICAL/i
  ];
  for (const line of lines) {
    for (const kw of goodsPatterns) {
      if (kw.test(line)) {
        purpose = line
          .replace(/\d+[\.,]\d{3}[\.,]?\d*\s*(KG|MT|PCS|USD|US\$)?/gi,"")
          .replace(/\d+\.\d+\s*(KG|MT)?/gi,"")
          .replace(/\s+/g," ").trim();
        if (purpose.length > 4) break;
      }
    }
    if (purpose) break;
  }
  if (!purpose) purpose = getAfterLabel(lines, /^Purpose\s*[:\-]/i) || "IMPORT OF GOODS";

  // 8. Amount — ALWAYS from instruction only
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
