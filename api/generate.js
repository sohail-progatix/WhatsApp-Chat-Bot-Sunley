const pdfParse = require("pdf-parse");

// Extract a value using multiple regex patterns
function extract(text, patterns) {
  for (const pattern of patterns) {
    const m = text.match(new RegExp(pattern, "i"));
    if (m) {
      // Return first captured group, or full match if no group
      const val = (m[1] || m[0]).trim().replace(/\s+/g, " ");
      if (val.length > 1) return val;
    }
  }
  return null;
}

// Parse amount from instruction e.g. "$28261" or "$28,261"
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

// Fill template lines with extracted values - only replace if we have a real value
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

  // ── Step 1: Parse PDF ──
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

  const t = pdfText.replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ");

  // ── Step 2: Extract beneficiary name ──
  // Could be company name at top of invoice - look for known patterns
  const beneficiaryName = extract(t, [
    // Look for company name near top - usually before address
    "(?:Sterling|Finvest|Trading|Corp|Inc|Ltd|LLC|GmbH|PVT)[^\n]{0,40}",
    // Seller/Beneficiary label
    "(?:Seller|Beneficiary|Company|From|Shipper)\\s*[:\\-]\\s*([^\\n]{3,60})",
    // First all-caps line that looks like a company name
    "^([A-Z][A-Z\\s&.,]{5,50}(?:INC|LTD|LLC|CORP|CO|PVT|SDN|BHD)\\.?)$",
  ]) || extract(t, [
    // Fallback: grab first prominent name-like line
    "([A-Z][A-Za-z\\s&.,]{4,50}(?:Inc|Ltd|LLC|Corp|Co|Pvt)\\.?)",
  ]);

  // ── Step 3: Extract beneficiary address ──
  // Look for seller address (not buyer address)
  const beneficiaryAddress = extract(t, [
    // Address near company header (before BUYER section)
    "([0-9]+[^\\n]{5,80}(?:Suite|Blvd|Boulevard|Street|St|Ave|Road|Rd)[^\\n]{0,60})",
    "([0-9]+\\s+(?:Satellite|Duluth|GA|USA|UK|Indonesia)[^\\n]{0,80})",
  ]) || extract(t, [
    "Address\\s*[:\\-]\\s*([^\\n]{5,100}(?:\\n[^\\n]{5,60}){0,2})",
  ]);

  // ── Step 4: Extract bank name ──
  const bankName = extract(t, [
    "BANK\\s*[:\\-]\\s*([^\\n]{3,60})",
    "Bank\\s+[Nn]ame\\s*[:\\-]\\s*([^\\n]{3,60})",
    "([A-Z][A-Za-z\\s]+BANK[^\\n]{0,30})",
    "(REGIONS\\s+BANK|MANDIRI|BARCLAYS|HSBC|CITIBANK|JP\\s*MORGAN|WELLS\\s+FARGO)[^\\n]{0,30}",
  ]);

  // ── Step 5: Extract bank address ──
  const bankAddress = extract(t, [
    "ADDRESS\\s*[:\\-]\\s*([^\\n]{5,80}(?:\\n[^\\n]{3,60}){0,2})",
    "(?:Bank\\s+)?Address\\s*[:\\-]\\s*([^\\n]{5,80})",
  ]);

  // ── Step 6: Extract account number ──
  const accountNo = extract(t, [
    "ACCOUNT\\s*#\\s*[:\\-]?\\s*([0-9]{6,20})",
    "Account\\s+(?:No\\.?|Number|#)\\s*[:\\-]?\\s*(?:USD\\s+account[:\\-]+\\s*)?([0-9]{6,20})",
    "A\\/C\\s*(?:No\\.?|#)?\\s*[:\\-]?\\s*([0-9]{6,20})",
    "([0-9]{9,16})",
  ]);

  // ── Step 7: Extract SWIFT ──
  const swiftCode = extract(t, [
    "SWIFT\\s*[:\\-#]?\\s*([A-Z0-9]{8,11})",
    "Swift\\s+[Cc]ode\\s*[:\\-]?\\s*([A-Z0-9]{8,11})",
    "BIC\\s*[:\\-]?\\s*([A-Z0-9]{8,11})",
  ]);

  // ── Step 8: Extract invoice number ──
  const invoiceNo = extract(t, [
    "INVOICE\\s*#\\s*[:\\-]?\\s*([A-Z0-9\\/\\-]{3,30})",
    "Invoice\\s+(?:No\\.?|Number|#)\\s*[:\\-]?\\s*([A-Z0-9\\/\\-]{3,30})",
    "INV\\s*[:\\-#]?\\s*([A-Z0-9\\/\\-]{3,30})",
  ]);

  // ── Step 9: Extract purpose from goods description ──
  const purpose = extract(t, [
    "Purpose\\s*[:\\-]\\s*([^\\n]{5,80})",
    "(?:PARTICULARS|DESCRIPTION|GOODS)\\s*[^\\n]*\\n+([^\\n]{5,80})",
    "(WASTE\\s+PAPER[^\\n]{0,40})",
    "(CIGARETTE\\s+PAPER[^\\n]{0,40})",
    "(CORK\\s+TIPPING[^\\n]{0,40})",
    "(?:for|re|re:)\\s+([^\\n]{5,60})",
  ]) || "IMPORT OF GOODS";

  // ── Step 10: Amount — from instruction first, then PDF ──
  const amountFromInstr = parseAmountFromInstruction(instruction);
  const amountFromPDF = extract(t, [
    "TOTAL\\s+US\\$\\s*([0-9,]+)",
    "TOTAL\\s*\\$?\\s*([0-9,]+(?:\\.[0-9]{2})?)",
    "Amount\\s+US\\$\\s*([0-9,]+)",
    "\\$\\s*([0-9,]{4,12}(?:\\.[0-9]{2})?)",
  ]);
  const amount = amountFromInstr || (amountFromPDF ? amountFromPDF + "/-" : null);

  // ── Step 11: Build values map (only include fields we actually found) ──
  const values = {};
  if (beneficiaryName)    values["BENEFICIARY NAME"]         = beneficiaryName.toUpperCase();
  if (beneficiaryAddress) values["BENEFICIARY ADDRESS"]      = beneficiaryAddress.toUpperCase().replace(/\n/g, " ");
  if (bankName)           values["BENEFICIARY BANK NAME"]    = bankName.toUpperCase();
  if (bankAddress)        values["BENEFICIARY BANK ADDRESS"] = bankAddress.toUpperCase().replace(/\n/g, " ");
  if (accountNo)          values["BENEFICIARY A/C NO"]       = accountNo;
  if (swiftCode)          values["SWIFT CODE"]               = swiftCode.toUpperCase();
  if (invoiceNo)          values["INVOICE NO"]               = invoiceNo.toUpperCase();
  if (purpose)            values["PURPOSE"]                  = purpose.toUpperCase();
  if (amount)             values["AMOUNT USD"]               = amount;

  // ── Step 12: Fill template or return structured output ──
  if (msgFormat && msgFormat.trim().length > 0) {
    const filled = fillTemplate(msgFormat, values);
    return res.status(200).json({ text: filled.trim() });
  }

  // No template — return all extracted fields
  const lines = Object.entries(values).map(([k, v]) => k + ": " + v);
  return res.status(200).json({ text: lines.join("\n\n") });
};
