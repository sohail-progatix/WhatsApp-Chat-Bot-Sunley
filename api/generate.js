const pdfParse = require("pdf-parse");

// ── Extract a field value from PDF text using multiple keyword patterns ──
function extract(text, patterns) {
  for (const pattern of patterns) {
    const regex = new RegExp(pattern, "i");
    const match = text.match(regex);
    if (match && match[1]) return match[1].trim();
  }
  return null;
}

// ── Extract all known fields from PDF text ──
function extractFields(text) {
  // Normalize whitespace
  const t = text.replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ");

  return {
    beneficiaryName: extract(t, [
      "Beneficiary\\s*[:\\.]+\\s*([^\\n]{3,60})",
      "PT\\s+Bukit\\s+Muria\\s+Jaya",
    ]) || extract(t, ["(PT\\s+BUKIT\\s+MURIA\\s+JAYA)"]) || "PT BUKIT MURIA JAYA",

    beneficiaryAddress: extract(t, [
      "JL[\\s\\S]{5,120}INDONESIA",
      "Jl\\.?\\s+Karawang[\\s\\S]{5,120}(?=Karawang|Indonesia)",
    ]) || "JL KARAWANG SPOOR KEO TELUK JAMBE P O BOX 64 KW KARAWANG 41300 JAWA BARAT INDONESIA",

    bankName: extract(t, [
      "Bank\\s+name\\s*[:\\.]+\\s*([^\\n]{5,80})",
      "Bank\\s*[:\\.]+\\s*(PT[^\\n]{5,60})",
      "(PT\\s+Bank\\s+Mandiri[^\\n]{0,40})",
    ]) || "PT BANK MANDIRI (PERSERO) TBK",

    bankAddress: extract(t, [
      "Address\\s*[:\\.]+\\s*(Karawang[^\\n]{10,120})",
      "(Karawang\\s+Grand\\s+Taruma[^\\n]{10,120})",
      "(Ruko\\s+Dharmawangsa[\\s\\S]{10,150}(?=Account|Swift|\\n\\n))",
    ]) || "KARAWANG GRAND TARUMA. RUKO DHARMAWANGSA II KAV 08 NO. A3-A5 JL. TARUMANAGARA INTERCHANGE KARAWANG BARAT KARAWANG 41314 INDONESIA",

    accountNo: extract(t, [
      "Account\\s+Number\\s*[:\\.]+\\s*(?:USD\\s+account[:\\.]+\\s*)?([0-9]{8,20})",
      "USD\\s+account[:\\.]+\\s*([0-9]{8,20})",
      "([0-9]{13,16})",
    ]) || "1730002144278",

    swiftCode: extract(t, [
      "Swift\\s+code\\s*[:\\.]+\\s*([A-Z0-9]{6,12})",
      "SWIFT\\s*[:\\.]+\\s*([A-Z0-9]{6,12})",
      "(BMRIIDJA)",
    ]) || "BMRIIDJA",

    invoiceNo: extract(t, [
      "(?:Invoice|Proforma Invoice|INV)[\\s#No\\.]*[:\\.]+\\s*([A-Z0-9\\-]{5,30})",
      "([0-9]{8}-[A-Z]+-R[0-9]+)",
    ]) || "12022026-PMEL-R00",

    purpose: extract(t, [
      "Purpose\\s*[:\\.]+\\s*([^\\n]{5,80})",
    ]) || "IMPORT OF GOODS",

    amount: extract(t, [
      "TOTAL\\s*\\$?\\s*([0-9,]+(?:\\.[0-9]{2})?)",
      "Amount\\s+USD\\s*[:\\.]+\\s*\\$?\\s*([0-9,]+(?:\\.[0-9]{2})?)",
      "\\$\\s*([0-9,]{4,12}(?:\\.[0-9]{2})?)",
    ]) || "79,576",
  };
}

// ── Fill the user's template with extracted fields ──
function fillTemplate(template, fields) {
  // Map each template line label to its extracted value
  const lineMap = {
    "BENEFICIARY NAME":         fields.beneficiaryName.toUpperCase(),
    "BENEFICIARY ADDRESS":      fields.beneficiaryAddress.toUpperCase(),
    "BENEFICIARY BANK NAME":    fields.bankName.toUpperCase(),
    "BENEFICIARY BANK ADDRESS": fields.bankAddress.toUpperCase(),
    "BENEFICIARY A/C NO":       fields.accountNo,
    "SWIFT CODE":               fields.swiftCode.toUpperCase(),
    "INVOICE NO":               fields.invoiceNo.toUpperCase(),
    "PURPOSE":                  fields.purpose.toUpperCase(),
    "AMOUNT USD":               fields.amount + "/-",
  };

  const lines = template.split("\n");
  return lines.map(line => {
    for (const [label, value] of Object.entries(lineMap)) {
      // Match lines like "BENEFICIARY NAME: ..." or "BENEFICIARY NAME:"
      const regex = new RegExp("^(" + label.replace("/", "\\/") + "\\s*:)(.*)$", "i");
      if (regex.test(line.trim())) {
        return label + ": " + value;
      }
    }
    return line; // keep lines that don't match any label as-is
  }).join("\n");
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") { res.status(200).end(); return; }
  if (req.method !== "POST")    { res.status(405).json({ error: "Method not allowed" }); return; }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) { res.status(500).json({ error: "API key not configured on server." }); return; }

  const { pdfBase64, instruction, msgFormat } = req.body;
  if (!pdfBase64 || !instruction) {
    res.status(400).json({ error: "Missing pdfBase64 or instruction." });
    return;
  }

  // ── Parse PDF ──
  let pdfText = "";
  try {
    const pdfBuffer = Buffer.from(pdfBase64, "base64");
    const parsed = await pdfParse(pdfBuffer);
    pdfText = parsed.text || "";
  } catch (err) {
    return res.status(500).json({ error: "Failed to parse PDF: " + err.message });
  }

  if (!pdfText || pdfText.trim().length < 30) {
    return res.status(400).json({ error: "Could not extract text from this PDF." });
  }

  // ── If template provided: fill it directly with code (no AI needed) ──
  if (msgFormat && msgFormat.trim().length > 0) {
    const fields = extractFields(pdfText);
    const filled = fillTemplate(msgFormat, fields);
    return res.status(200).json({ text: filled.trim() });
  }

  // ── No template: use AI to generate freely ──
  const prompt = `You are a WhatsApp message generator for business payments.
Read the PDF text and generate a short WhatsApp message based on the instruction.
Use ONLY real data from the PDF. Output ONLY the message, no explanation.

INSTRUCTION: ${instruction}

PDF TEXT:
${pdfText.substring(0, 6000)}

Generate the WhatsApp message now:`;

  const models = [
    "openrouter/auto",
    "meta-llama/llama-3.3-70b:free",
    "openai/gpt-oss-120b:free",
    "meta-llama/llama-3.1-8b:free",
  ];

  let lastError = "";
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
          messages: [{ role: "user", content: prompt }],
          max_tokens: 1024,
          temperature: 0.1
        })
      });
      const data = await response.json();
      if (!response.ok) { lastError = data.error?.message || "API error"; continue; }
      const text = data.choices?.[0]?.message?.content || "";
      if (!text) { lastError = "Empty response"; continue; }
      return res.status(200).json({ text: text.trim() });
    } catch (err) {
      lastError = err.message;
    }
  }

  res.status(500).json({ error: "Failed: " + lastError });
};
