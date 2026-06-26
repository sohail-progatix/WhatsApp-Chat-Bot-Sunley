export default async function handler(req, res) {
  // Allow CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }
  if (req.method !== "POST")    { res.status(405).json({ error: "Method not allowed" }); return; }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) { res.status(500).json({ error: "API key not configured on server." }); return; }

  const { pdfBase64, instruction, msgFormat } = req.body;
  if (!pdfBase64 || !instruction) {
    res.status(400).json({ error: "Missing pdfBase64 or instruction." });
    return;
  }

  const prompt = `You are a WhatsApp message generator assistant.
Extract relevant information from the PDF and generate a clear, professional WhatsApp message.
If a message format/template is provided, fill it in exactly using the correct values from the PDF.
Output ONLY the final WhatsApp message — no commentary, no explanation, no markdown formatting.
If multiple messages are needed, separate them with "--- Message 1 ---", "--- Message 2 ---" etc.

Instruction: ${instruction}
${msgFormat ? `\nRequired message format to fill in:\n${msgFormat}\n` : ""}
Generate the WhatsApp message now.`;

  const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;

  try {
    const geminiRes = await fetch(geminiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{
          parts: [
            { inline_data: { mime_type: "application/pdf", data: pdfBase64 } },
            { text: prompt }
          ]
        }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 1024 }
      })
    });

    const data = await geminiRes.json();
    if (!geminiRes.ok) throw new Error(data.error?.message || "Gemini API error");

    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
    if (!text) throw new Error("No response from Gemini.");

    res.status(200).json({ text });
  } catch (err) {
    res.status(500).json({ error: err.message || "Server error." });
  }
}
