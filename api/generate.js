const pdfParse = require("pdf-parse");

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

  // ── Step 1: Parse PDF ──
  let pdfText = "";
  try {
    const pdfBuffer = Buffer.from(pdfBase64, "base64");
    const parsed = await pdfParse(pdfBuffer);
    pdfText = parsed.text || "";
  } catch (err) {
    return res.status(500).json({ error: "Failed to parse PDF: " + err.message });
  }

  if (!pdfText || pdfText.trim().length < 30) {
    return res.status(400).json({
      error: "Could not extract text from this PDF. It may be a scanned image. Please use a text-based PDF."
    });
  }

  // ── Step 2: Build strict prompt ──
  let prompt = "";

  if (msgFormat && msgFormat.trim().length > 0) {
    // STRICT MODE — template must be filled exactly
    prompt = `You are a data extraction assistant. Your ONLY job is to copy the template below and fill in the values from the PDF.

CRITICAL RULES — YOU MUST FOLLOW THESE EXACTLY:
1. Copy the TEMPLATE below character by character
2. Replace NOTHING except fill in the actual values from the PDF after each colon
3. Keep every line label exactly as written (e.g. "BENEFICIARY NAME:" stays exactly as "BENEFICIARY NAME:")
4. Do NOT add any extra text, greetings, notes, or explanation
5. Do NOT change the order of lines
6. Do NOT generate a "payment reminder" or any other format
7. Output ONLY the filled template — nothing before it, nothing after it

TEMPLATE TO FILL:
${msgFormat.trim()}

PDF DATA TO EXTRACT FROM:
${pdfText.substring(0, 8000)}

Now output the filled template ONLY. Start directly with the first line of the template:`;

  } else {
    // NO TEMPLATE — generate from instruction
    prompt = `You are a WhatsApp message generator for business payments.
Read the PDF text and generate a WhatsApp message based on the instruction.
Use ONLY real data from the PDF. Output ONLY the message, no explanation.

INSTRUCTION: ${instruction}

PDF TEXT:
${pdfText.substring(0, 8000)}

Generate the WhatsApp message now:`;
  }

  // ── Step 3: Try free models ──
  const models = [
    "openrouter/auto",
    "meta-llama/llama-3.3-70b:free",
    "openai/gpt-oss-120b:free",
    "meta-llama/llama-3.1-8b:free",
    "mistralai/mistral-7b-instruct:free"
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
          messages: [
            {
              role: "system",
              content: msgFormat
                ? "You are a template filling assistant. You copy templates exactly and only fill in values. You never add extra text or change the format."
                : "You are a WhatsApp message generator. You use only real data from PDFs provided."
            },
            {
              role: "user",
              content: prompt
            }
          ],
          max_tokens: 1024,
          temperature: 0.0  // zero temperature = most deterministic, follows instructions strictly
        })
      });

      const data = await response.json();

      if (!response.ok) {
        lastError = data.error?.message || `Model ${model} failed`;
        continue;
      }

      let text = data.choices?.[0]?.message?.content || "";
      if (!text) { lastError = "Empty response from " + model; continue; }

      // Clean up any preamble the model may have added before the template
      if (msgFormat) {
        const firstLine = msgFormat.trim().split("\n")[0].split(":")[0].trim();
        const idx = text.indexOf(firstLine);
        if (idx > 0) text = text.substring(idx);
      }

      res.status(200).json({ text: text.trim() });
      return;

    } catch (err) {
      lastError = err.message;
      continue;
    }
  }

  res.status(500).json({ error: "All models failed. Last error: " + lastError });
};
