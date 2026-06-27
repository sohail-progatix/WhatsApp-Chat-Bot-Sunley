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

// ── Call OpenRouter AI to extract fields from raw PDF text ──
async function extractFieldsWithAI(rawText, apiKey) {
  const systemPrompt = `You are a payment document parser. Extract payment fields from invoice text.
Return ONLY a JSON object with these exact keys (use null if not found):
{
  "beneficiary_name": "company name of the SELLER/SUPPLIER (not the buyer)",
  "beneficiary_address": "full address of the SELLER/SUPPLIER (not the buyer)",
  "bank_name": "beneficiary bank name",
  "bank_address": "beneficiary bank address (if available)",
  "account_no": "bank account number (digits only)",
  "swift_code": "SWIFT/BIC code",
  "invoice_no": "invoice or pro-forma number",
  "purpose": "goods description (what is being sold, e.g. PERFUME COMPOUND, WASTE PAPER)"
}

RULES:
- beneficiary_name is the ISSUER of the invoice (seller), NOT the buyer/bill-to party
- For purpose: use the main goods description, not company names
- account_no: digits only, no spaces or labels
- Return ONLY valid JSON, no explanation, no markdown`;

  const userPrompt = `Extract payment fields from this invoice text:\n\n${rawText.substring(0, 6000)}`;

  const models = [
    "openrouter/auto",
    "meta-llama/llama-3.3-70b:free",
    "meta-llama/llama-3.1-8b:free",
    "mistralai/mistral-7b-instruct:free"
  ];

  for (const model of models) {
    try {
      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://msg-bot-psi.vercel.app",
          "X-Title": "WhatsApp PDF Message Generator"
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt }
          ],
          max_tokens: 500,
          temperature: 0.0
        })
      });

      const data = await response.json();
      if (!response.ok) continue;

      let text = data.choices?.[0]?.message?.content || "";
      // Strip markdown code blocks if present
      text = text.replace(/```json\s*/gi,"").replace(/```\s*/g,"").trim();

      const parsed = JSON.parse(text);
      return parsed;
    } catch(e) {
      continue;
    }
  }
  return null;
}

// ── Get OCR text from ocr.space ──
async function getOCRText(pdfBase64) {
  try {
    const apiKey = process.env.OCR_API_KEY || "helloworld";
    const resp = await fetch("https://api.ocr.space/parse/image", {
      method: "POST",
      headers: { "apikey": apiKey, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        base64Image: "data:application/pdf;base64," + pdfBase64,
        language: "eng", isOverlayRequired: "false",
        filetype: "PDF", OCREngine: "2", scale: "true"
      }).toString()
    });
    const raw = await resp.text();
    const data = JSON.parse(raw);
    return data?.ParsedResults?.map(r => r.ParsedText || "").join("\n") || "";
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

  const openRouterKey = process.env.OPENROUTER_API_KEY;
  if (!openRouterKey) return res.status(500).json({ error: "OPENROUTER_API_KEY not configured." });

  const { pdfBase64, instruction, msgFormat } = req.body;
  if (!pdfBase64 || !instruction)
    return res.status(400).json({ error: "Missing pdfBase64 or instruction." });

  // ── Step 1: Extract text via pdf-parse ──
  let pdfText = "";
  try {
    const parsed = await pdfParse(Buffer.from(pdfBase64, "base64"));
    pdfText = parsed.text || "";
  } catch(e) {}

  // ── Step 2: OCR for image-based content ──
  let ocrText = "";
  try {
    ocrText = await getOCRText(pdfBase64);
  } catch(e) {}

  // ── Step 3: Combine both — OCR first captures image headers ──
  const combinedText = [ocrText, pdfText].filter(Boolean).join("\n\n--- PDF TEXT ---\n\n");

  if (combinedText.trim().length < 20)
    return res.status(400).json({ error: "Could not extract text from PDF." });

  // ── Step 4: AI extracts all fields intelligently ──
  const fields = await extractFieldsWithAI(combinedText, openRouterKey);

  if (!fields)
    return res.status(500).json({ error: "AI could not parse the document. Please try again." });

  // ── Step 5: Amount always from instruction ──
  const amount = parseAmountFromInstruction(instruction);

  // ── Step 6: Build values map ──
  const clean = s => s && s !== "null" ? s.replace(/\s+/g," ").trim().toUpperCase() : null;

  const values = {};
  if (fields.beneficiary_name)    values["BENEFICIARY NAME"]         = clean(fields.beneficiary_name);
  if (fields.beneficiary_address) values["BENEFICIARY ADDRESS"]      = clean(fields.beneficiary_address);
  if (fields.bank_name)           values["BENEFICIARY BANK NAME"]    = clean(fields.bank_name);
  if (fields.bank_address)        values["BENEFICIARY BANK ADDRESS"] = clean(fields.bank_address);
  if (fields.account_no)          values["BENEFICIARY A/C NO"]       = String(fields.account_no).replace(/\s/g,"").trim();
  if (fields.swift_code)          values["SWIFT CODE"]               = String(fields.swift_code).replace(/[^A-Z0-9]/gi,"").toUpperCase();
  if (fields.invoice_no)          values["INVOICE NO"]               = String(fields.invoice_no).trim().toUpperCase();
  if (fields.purpose)             values["PURPOSE"]                  = clean(fields.purpose);
  if (amount)                     values["AMOUNT USD"]               = amount;

  // ── Step 7: Fill template or return structured output ──
  if (msgFormat && msgFormat.trim().length > 0) {
    return res.status(200).json({ text: fillTemplate(msgFormat, values).trim() });
  }

  const outLines = Object.entries(values).map(([k,v]) => k + ": " + v);
  return res.status(200).json({ text: outLines.join("\n\n") });
};
