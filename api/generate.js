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

  const prompt = `You are a WhatsApp message generator assistant.
The user has provided a business PDF document (proforma invoice, contract, or similar) and an instruction.
Extract all relevant information from the PDF text and generate a clear, professional WhatsApp message.
If a message format/template is provided, fill it in exactly using the correct values from the PDF.
Output ONLY the final WhatsApp message — no commentary, no explanation, no markdown formatting.
If multiple messages are needed, separate them with "--- Message 1 ---", "--- Message 2 ---" etc.

Instruction: ${instruction}
${msgFormat ? `\nRequired message format to fill in:\n${msgFormat}\n` : ""}

PDF document content (base64 encoded): The document contains business/financial data. Extract key fields like:
- Beneficiary name and address
- Bank name and address  
- Account number
- SWIFT code
- Invoice number
- Amount
- Purpose

PDF base64 (first 6000 chars): ${pdfBase64.substring(0, 6000)}

Generate the WhatsApp message now using only the data found in the PDF above.`;

  // Confirmed free models on OpenRouter as of June 2026
  // openrouter/free auto-selects the best available free model
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
          model: model,
          messages: [{ role: "user", content: prompt }],
          max_tokens: 1024,
          temperature: 0.2
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
