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

  // ── Step 1: Parse PDF properly using pdf-parse ──
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

  // ── Step 2: Build prompt with real extracted text ──
  const prompt = `You are a WhatsApp message generator for business payments.

TASK: Read the PDF text below and generate a WhatsApp message.

STRICT RULES:
- Use ONLY data found in the PDF text below — do NOT invent or assume any values
- If a message format is provided, fill EVERY field with exact values from the PDF
- Output ONLY the final WhatsApp message — no preamble, no explanation, no markdown
- Do not make up names, account numbers, or amounts not found in the PDF

INSTRUCTION: ${instruction}
${msgFormat ? `\nMESSAGE FORMAT TO FILL (replace every ... with real values from PDF):\n${msgFormat}\n` : ""}

PDF TEXT:
${pdfText.substring(0, 8000)}

Generate the WhatsApp message now using ONLY the real data above:`;

  // ── Step 3: Try free models in order ──
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
          messages: [{ role: "user", content: prompt }],
          max_tokens: 1024,
          temperature: 0.1
        })
      });

      const data = await response.json();

      if (!response.ok) {
        lastError = data.error?.message || `Model ${model} failed`;
        continue;
      }

      const text = data.choices?.[0]?.message?.content || "";
      if (!text) { lastError = "Empty response from " + model; continue; }

      res.status(200).json({ text });
      return;

    } catch (err) {
      lastError = err.message;
      continue;
    }
  }

  res.status(500).json({ error: "All models failed. Last error: " + lastError });
};
