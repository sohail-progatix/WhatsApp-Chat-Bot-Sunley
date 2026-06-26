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

  // Convert PDF base64 to text extraction prompt
  const prompt = `You are a WhatsApp message generator assistant.
The user has provided a PDF document encoded in base64 and an instruction.
First extract all text content from the PDF, then generate a WhatsApp message.
If a message format/template is provided, fill it in exactly using the correct values from the PDF.
Output ONLY the final WhatsApp message — no commentary, no explanation, no markdown formatting.
If multiple messages are needed, separate them with "--- Message 1 ---", "--- Message 2 ---" etc.

Instruction: ${instruction}
${msgFormat ? `\nRequired message format to fill in:\n${msgFormat}\n` : ""}

The PDF is encoded in base64 below. Extract the relevant data and generate the WhatsApp message:
${pdfBase64.substring(0, 8000)}

Generate the WhatsApp message now.`;

  // Try multiple free models in order until one works
  const models = [
    "meta-llama/llama-3.3-70b-instruct:free",
    "meta-llama/llama-3.1-8b-instruct:free",
    "mistralai/mistral-7b-instruct:free",
    "deepseek/deepseek-r1:free",
    "qwen/qwen2.5-vl-72b-instruct:free"
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
        lastError = data.error?.message || "API error";
        continue; // try next model
      }

      const text = data.choices?.[0]?.message?.content || "";
      if (!text) {
        lastError = "Empty response";
        continue; // try next model
      }

      res.status(200).json({ text, model_used: model });
      return;

    } catch (err) {
      lastError = err.message;
      continue; // try next model
    }
  }

  // All models failed
  res.status(500).json({ error: "All models failed. Last error: " + lastError });
};
