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

function buildFieldMap(text) {
  const lines = text.split("\n").map(l => l.trim()).filter(l => l.length > 0);
  const map = {};
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const label = line.substring(0, colonIdx).trim().toUpperCase();
    if (label.length < 2 || label.length > 30) continue;
    const inlineVal = line.substring(colonIdx + 1).trim();
    if (inlineVal.length > 0) {
      map[label] = inlineVal;
    } else {
      const vals = [];
      let j = i + 1;
      while (j < lines.length && j < i + 6) {
        const next = lines[j];
        if (/^[A-Z][A-Z\s#\/]{1,25}:/.test(next)) break;
        vals.push(next);
        j++;
      }
      if (vals.length > 0) map[label] = vals.join(" ");
    }
  }
  return map;
}

function extractSellerName(lines) {
  for (const line of lines) {
    if (/^(COMMERCIAL|PROFORMA|BUYER|DATE|INVOICE|PARTICULARS|TO\s*:)/i.test(line)) break;
    if (/^\d[\d\s\-\+\(\)]{4,}$/.test(line)) continue;
    if (/@/.test(line)) continue;
    if (/[a-zA-Z]{3,}/.test(line)) return line;
  }
  return null;
}

function extractSellerAddress(lines) {
  const addrLines = [];
  let foundName = false;
  for (const line of lines) {
    if (/^(COMMERCIAL|PROFORMA|BUYER|DATE|INVOICE|PARTICULARS|TO\s*:)/i.test(line)) break;
    if (!foundName) {
      if (/^\d[\d\s\-\+\(\)]{4,}$/.test(line)) continue;
      if (/@/.test(line)) continue;
      if (/[a-zA-Z]{3,}/.test(line)) { foundName = true; continue; }
    } else {
      if (/^\d[\d\s\-\+\(\)]{4,}$/.test(line)) continue;
      if (/@/.test(line)) continue;
      addrLines.push(line);
      if (addrLines.length >= 4) break;
    }
  }
  return addrLines.length > 0 ? addrLines.join(" ") : null;
}

// ── OCR via ocr.space — safe JSON parse ──
async function ocrWithAPI(pdfBase64) {
  try {
    const apiKey = process.env.OCR_API_KEY || "helloworld";

    const response = await fetch("https://api.ocr.space/parse/image", {
      method: "POST",
      headers: {
        "apikey": apiKey,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({
        base64Image: "data:application/pdf;base64," + pdfBase64,
        language: "eng",
        isOverlayRequired: "false",
        filetype: "PDF",
        detectOrientation: "true",
        scale: "true",
        isTable: "true",
        OCREngine: "2"
      }).toString()
    });

    // Safe parse — don't crash if not JSON
    const raw = await response.text();
    let data;
    try { data = JSON.parse(raw); } catch(e) { return ""; }

    if (data && data.ParsedResults && data.ParsedResults.length > 0) {
      return data.ParsedResults.map(r => r.ParsedText || "").join("\n");
    }
    return "";
  } catch(e) {
    return "";
  }
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

  const pdfBuffer = Buffer.from(pdfBase64, "base64");

  // ── Step 1: pdf-parse ──
  let pdfText = "";
  try {
    const parsed = await pdfParse(pdfBuffer);
    pdfText = parsed.text || "";
  } catch(e) {}

  // ── Step 2: OCR for image-based content ──
  let ocrText = "";
  try {
    ocrText = await ocrWithAPI(pdfBase64);
  } catch(e) {}

  // ── Step 3: Merge — OCR first so image header is prioritised ──
  const combinedText = ocrText + "\n" + pdfText;

  if (combinedText.trim().length < 10)
    return res.status(400).json({ error: "Could not extract any text from this PDF." });

  const rawLines = combinedText.split("\n").map(l => l.trim()).filter(l => l.length > 0);
  const fields   = buildFieldMap(combinedText);

  // ── Extract all fields ──
  const sellerName    = extractSellerName(rawLines);
  const sellerAddress = extractSellerAddress(rawLines);

  const bankName = fields["BANK"] || fields["BANK NAME"] || fields["BENEFICIARY BANK"] || null;

  let bankAddress = fields["ADDRESS"] || null;
  if (bankAddress) bankAddress = bankAddress.replace(/\s*ABA\s*#.*$/i,"").replace(/,\s*$/,"").trim();

  const accountNo = fields["ACCOUNT #"] || fields["ACCOUNT NO"] ||
                    fields["ACCOUNT NUMBER"] || fields["ACCOUNT"] || null;

  const swiftCode = fields["SWIFT"] || fields["SWIFT CODE"] || fields["BIC"] || null;

  const invoiceNo = fields["INVOICE #"] || fields["INVOICE NO"] ||
                    fields["INVOICE NUMBER"] || fields["INV #"] || null;

  let purpose = null;
  for (const line of rawLines) {
    if (/WASTE\s+PAPER/i.test(line))     { purpose = line.replace(/H\.S\..*$/i,"").trim(); break; }
    if (/CIGARETTE\s+PAPER/i.test(line)) { purpose = line.trim(); break; }
    if (/CORK\s+TIPPING/i.test(line))    { purpose = line.trim(); break; }
    if (/TEXTILE/i.test(line))           { purpose = line.trim(); break; }
  }
  if (!purpose) purpose = fields["PURPOSE"] || "IMPORT OF GOODS";

  const amountFromInstr = parseAmountFromInstruction(instruction);
  let amountFromPDF = fields["TOTAL"] || null;
  if (amountFromPDF) amountFromPDF = amountFromPDF.replace(/US\$|USD|\$/gi,"").trim() + "/-";
  const amount = amountFromInstr || amountFromPDF;

  const clean = s => s ? s.replace(/,\s*$/,"").replace(/\s+/g," ").trim().toUpperCase() : null;

  const values = {};
  if (sellerName)    values["BENEFICIARY NAME"]         = clean(sellerName);
  if (sellerAddress) values["BENEFICIARY ADDRESS"]      = clean(sellerAddress);
  if (bankName)      values["BENEFICIARY BANK NAME"]    = clean(bankName);
  if (bankAddress)   values["BENEFICIARY BANK ADDRESS"] = clean(bankAddress);
  if (accountNo)     values["BENEFICIARY A/C NO"]       = accountNo.trim();
  if (swiftCode)     values["SWIFT CODE"]               = swiftCode.trim().toUpperCase();
  if (invoiceNo)     values["INVOICE NO"]               = invoiceNo.trim().toUpperCase();
  if (purpose)       values["PURPOSE"]                  = clean(purpose);
  if (amount)        values["AMOUNT USD"]               = amount;

  // ── Return debug info so we can see what was extracted ──
  if (msgFormat && msgFormat.trim().length > 0) {
    return res.status(200).json({
      text: fillTemplate(msgFormat, values).trim(),
      debug: { ocrLines: ocrText.split("\n").slice(0,20), pdfLines: pdfText.split("\n").slice(0,20) }
    });
  }

  const lines = Object.entries(values).map(([k,v]) => k + ": " + v);
  return res.status(200).json({
    text: lines.join("\n\n"),
    debug: { ocrLines: ocrText.split("\n").slice(0,20), pdfLines: pdfText.split("\n").slice(0,20) }
  });
};
