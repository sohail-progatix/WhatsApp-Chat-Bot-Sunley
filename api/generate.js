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

// Stop words — lines we never want as seller name
function isJunkLine(line) {
  return !line ||
    /^\d[\d\s\-\+\(\)]{4,}$/.test(line) ||   // phone/fax number
    /@/.test(line) ||                           // email
    /^\+\d/.test(line) ||                       // phone +31...
    /^(Chamber|Phone|VAT|Tax|Reg|Page|All orders|Pro.Forma\s+No|Total|Freight|EXPORT|ATTENTION|FOR INVOICE|Line\s+Material)/i.test(line) ||
    /^(COMMERCIAL|BUYER|BILL\s+TO|SHIP\s+TO|TO\s*:|Please\s+pay|Intermediate)/i.test(line) ||
    line.length < 4;
}

// ── SELLER EXTRACTION ──
function extractSeller(pdfLines) {

  // ── LAYOUT A: IFF style ──
  // pdf-parse output has: "Pro Forma Invoice Page 1 of 4" marker
  // After that: short ID line (all caps, short) → full legal name → address
  const pageMarkerIdx = pdfLines.findIndex(l =>
    /Pro\s*Forma\s+Invoice\s+Page\s+\d/i.test(l)
  );

  if (pageMarkerIdx >= 0) {
    const afterPage = pdfLines.slice(pageMarkerIdx + 1);
    let name = null;
    const addrLines = [];

    for (let i = 0; i < afterPage.length; i++) {
      const line = afterPage[i].trim();
      if (!line) continue;
      if (isJunkLine(line)) break;

      if (!name) {
        // Short all-caps line = letterhead ID → skip it, use next line as real name
        const isShortCaps = /^[A-Z0-9\s\(\)\.&\-\/]{3,25}$/.test(line);
        if (isShortCaps && i + 1 < afterPage.length) {
          const nextLine = afterPage[i + 1].trim();
          // Next line is the full legal name (has lowercase letters)
          if (/[a-z]/.test(nextLine) && !isJunkLine(nextLine)) {
            name = nextLine;
            i++; // consumed next line
            continue;
          }
        }
        name = line;
        continue;
      }

      // Collect address lines
      if (isJunkLine(line)) break;
      addrLines.push(line);
      if (addrLines.length >= 3) break;
    }

    if (name && addrLines.length > 0) {
      return { name: name.trim(), address: addrLines.join(" ") };
    }
  }

  // ── LAYOUT B: BMJ style ──
  // Seller at TOP before "TO :" / "BUYER:" / "Pro-Forma No."
  const stopIdx = pdfLines.findIndex(l =>
    /^(BUYER|BILL\s+TO|TO\s*:|Pro.Forma\s+No|Line\s+Material|DATE\s*:|COMMERCIAL\s+INVOICE)/i.test(l)
  );
  const topLines = stopIdx > 1 ? pdfLines.slice(0, stopIdx) : [];

  if (topLines.length > 0) {
    let name = null;
    const addrLines = [];
    for (const line of topLines) {
      if (isJunkLine(line)) continue;
      if (!name) { name = line; continue; }
      addrLines.push(line);
    }
    if (name && addrLines.length > 0) return { name, address: addrLines.join(" ") };
  }

  return { name: null, address: null };
}

// ── EXTRACT PURPOSE — only goods/product lines ──
function extractPurpose(lines) {
  const goodsKeywords = [
    /PERFUME\s+COMPOUND/i,
    /WASTE\s+PAPER/i,
    /CIGARETTE\s+PAPER/i,
    /CORK\s+TIPPING/i,
    /FRAGRANCE\s+(?:COMPOUND|OIL|MATERIAL)/i,
    /TEXTILE/i,
    /CHEMICAL/i,
    /FLAVOUR|FLAVOR/i,
  ];

  for (const line of lines) {
    // Skip lines that are clearly company/address info
    if (/Flavors\s*&\s*Fragrances/i.test(line)) continue;
    if (/International\s+Flavors/i.test(line)) continue;
    if (/B\.V\.|Inc\.|Ltd\.|LLC/i.test(line)) continue;

    for (const kw of goodsKeywords) {
      if (kw.test(line)) {
        // Clean numbers, weights, prices from the line
        let clean = line
          .replace(/\d{1,3}(,\d{3})*(\.\d+)?\s*(KG|MT|PCS|USD|US\$|\/\s*KG)?/gi, "")
          .replace(/\s+/g, " ")
          .trim();
        // Remove trailing punctuation
        clean = clean.replace(/[,\.\-\/]+$/, "").trim();
        if (clean.length > 4) return clean;
      }
    }
  }
  return "IMPORT OF GOODS";
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

  // ── Parse PDF text only (no OCR — OCR was causing confusion) ──
  let pdfText = "";
  try {
    const parsed = await pdfParse(Buffer.from(pdfBase64, "base64"));
    pdfText = parsed.text || "";
  } catch(e) {
    return res.status(500).json({ error: "Failed to parse PDF." });
  }

  // ── For Sterling-style PDFs (image header), use OCR only as LAST resort ──
  const pdfLines = pdfText.split("\n").map(l => l.trim()).filter(l => l.length > 0);

  // Check if pdf-parse gave us meaningful seller info
  // If first 5 lines are all document keywords → likely image header → try OCR
  const topMeaningful = pdfLines.slice(0, 5).filter(l =>
    !/^(COMMERCIAL|Pro.Forma|DATE|INVOICE|BUYER|Bill|Ship|Page)/i.test(l) &&
    /[a-zA-Z]{4,}/.test(l)
  );

  let ocrLines = [];
  if (topMeaningful.length === 0) {
    // Image-based header — use OCR to get seller info
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
        if (data?.ParsedResults?.[0]?.ParsedText) {
          ocrLines = data.ParsedResults[0].ParsedText
            .split("\n").map(l => l.trim()).filter(l => l.length > 0);
        }
      } catch(e) {}
    } catch(e) {}
  }

  // Use PDF lines for everything; only use OCR lines for seller if needed
  const seller = extractSeller(pdfLines) ||
    (ocrLines.length > 0 ? extractSeller(ocrLines) : { name: null, address: null });

  // All field extraction uses PDF lines only
  const lines = pdfLines;

  // ── Bank name ──
  let bankName = null;
  const payToIdx = lines.findIndex(l => /^Please\s+pay\s+to\s*$/i.test(l));
  if (payToIdx >= 0 && lines[payToIdx + 1]) {
    bankName = lines[payToIdx + 1].trim();
  } else {
    bankName = getAfterLabel(lines, /^BANK\s*[:\-]/i) ||
               getAfterLabel(lines, /^Bank\s+[Nn]ame\s*[:\-]/i) || null;
  }

  // ── Bank address ──
  let bankAddress = getAfterLabel(lines, /^ADDRESS\s*[:\-]/i) || null;
  if (bankAddress) bankAddress = bankAddress.replace(/\s*ABA\s*#.*$/i,"").replace(/,\s*$/,"").trim();

  // ── Account number ──
  let accountNo =
    getAfterLabel(lines, /^Bank\s+Account\s*[:\-]/i) ||
    getAfterLabel(lines, /^ACCOUNT\s*#\s*/i) ||
    getAfterLabel(lines, /^Account\s+Number\s*[:\-]/i) ||
    getAfterLabel(lines, /^A\/C\s*(?:No\.?)?\s*[:\-]/i) || null;
  if (accountNo) {
    const m = accountNo.match(/([0-9]{6,20})/);
    if (m) accountNo = m[1];
  }

  // ── SWIFT ──
  let swiftCode =
    getAfterLabel(lines, /^Swift\s+code\s*[:\-]/i) ||
    getAfterLabel(lines, /^SWIFT\s+CODE\s*[:\-]/i) ||
    getAfterLabel(lines, /^SWIFT\s*[:\-#]/i) ||
    getAfterLabel(lines, /^BIC\s*[:\-]/i) || null;
  if (swiftCode) swiftCode = swiftCode.replace(/[^A-Z0-9]/gi,"").toUpperCase();

  // ── Invoice number ──
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

  // ── Purpose ──
  const purpose = extractPurpose(lines);

  // ── Amount — ALWAYS from instruction ──
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
