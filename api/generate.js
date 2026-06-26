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
The user has provided a PDF document (as base64) and an instruction.
Extract relevant information from the PDF and generate a clear, professional WhatsApp message.
If a message format/template is provided, fill it in exactly using the correct values from the PDF.
Output ONLY the final WhatsApp message — no commentary, no explanation, no markdown formatting.
If multiple messages are needed, separate them with "--- Message 1 ---", "--- Message 2 ---" etc.

Instruction: ${instruction}
${msgFormat ? `\nRequired message format to fill in:\n${msgFormat}\n` : ""}

PDF Content (base64): ${pdfBase64}

Generate the WhatsApp message now.`;

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
        model: "google/gemini-2.0-flash-exp:free",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: prompt
              },
              {
                type: "image_url",
                image_url: {
                  url: `data:application/pdf;base64,${pdfBase64}`
                }
              }
            ]
          }
        ],
        max_tokens: 1024,
        temperature: 0.2
      })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error?.message || "OpenRouter API error");
    }

    const text = data.choices?.[0]?.message?.content || "";
    if (!text) throw new Error("No response received. Try again.");

    res.status(200).json({ text });
  } catch (err) {
    res.status(500).json({ error: err.message || "Server error." });
  }
};
