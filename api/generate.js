const https = require("https");
const http = require("http");

// Simple fetch helper for Node.js without node-fetch dependency
function fetchJSON(url, options) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const lib = urlObj.protocol === "https:" ? https : http;
    const reqOptions = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: options.method || "GET",
      headers: options.headers || {}
    };
    const req = lib.request(reqOptions, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try {
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, json: () => JSON.parse(data) });
        } catch(e) { reject(e); }
      });
    });
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

// Extract readable text from PDF base64 using simple pattern matching
function extractTextFromPDFBase64(base64) {
  try {
    const buffer = Buffer.from(base64, "base64");
    const pdfText = buffer.toString("latin1");
    
    // Extract text between BT (Begin Text) and ET (End Text) markers in PDF
    const textChunks = [];
    const btEtRegex = /BT([\s\S]*?)ET/g;
    let match;
    while ((match = btEtRegex.exec(pdfText)) !== null) {
      const block = match[1];
      // Extract strings in parentheses
      const strRegex = /\(([^)]+)\)/g;
      let strMatch;
      while ((strMatch = strRegex.exec(block)) !== null) {
        const str = strMatch[1]
          .replace(/\\n/g, "\n")
          .replace(/\\r/g, "\r")
          .replace(/\\t/g, "\t")
          .replace(/\\\(/g, "(")
          .replace(/\\\)/g, ")")
          .replace(/\\\\/g, "\\")
          .trim();
        if (str.length > 1) textChunks.push(str);
      }
    }

    // Also try to get text from stream content
    const streamRegex = /stream([\s\S]*?)endstream/g;
    while ((match = streamRegex.exec(pdfText)) !== null) {
      const streamContent = match[1];
      const strRegex2 = /\(([^)]{2,100})\)/g;
      let sm;
      while ((sm = strRegex2.exec(streamContent)) !== null) {
        const s = sm[1].replace(/[^\x20-\x7E\n\r\t]/g, " ").trim();
        if (s.length > 2 && /[a-zA-Z0-9]/.test(s)) textChunks.push(s);
      }
    }

    const extracted = textChunks.join(" ").replace(/\s+/g, " ").trim();
    return extracted.length > 100 ? extracted : null;
  } catch(e) {
    return null;
  }
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

  // Extract real text from the PDF
  const extractedText = extractTextFromPDFBase64(pdfBase64);

  let pdfContent;
  if (extractedText && extractedText.length > 100) {
    pdfContent = `EXTRACTED PDF TEXT:\n${extractedText.substring(0, 8000)}`;
  } else {
    // Fallback: send raw base64 chunk and ask model to try
    pdfContent = `PDF BASE64 (extract what you can):\n${pdfBase64.substring(0, 5000)}`;
  }

  const prompt = `You are a WhatsApp message generator for business payments.

TASK: Read the PDF content below, extract the real data, and generate a WhatsApp message.

STRICT RULES:
- Use ONLY data found in the PDF below — do NOT invent or assume any values
- If a message format is provided, fill EVERY field with exact values from the PDF
- Output ONLY the final WhatsApp message — no commentary, no explanation
- Do not use placeholder examples like "Sunley Fabrics" or "Barclays Bank" unless they are actually in the PDF

INSTRUCTION: ${instruction}
${msgFormat ? `\nMESSAGE FORMAT TO FILL IN (replace every ... with real PDF data):\n${msgFormat}\n` : ""}

${pdfContent}

Now generate the WhatsApp message using ONLY the real data found above:`;

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
      const response = await fetchJSON("https://openrouter.ai/api/v1/chat/completions", {
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
          temperature: 0.1
        })
      });

      const data = response.json();

      if (!response.ok) {
        lastError = data.error?.message || `Model ${model} failed`;
        continue;
      }

      const text = data.choices?.[0]?.message?.content || "";
      if (!text) { lastError = "Empty response from " + model; continue; }

      // Return extracted text too so frontend can show debug info
      res.status(200).json({ 
        text,
        extracted_length: extractedText ? extractedText.length : 0
      });
      return;

    } catch (err) {
      lastError = err.message;
      continue;
    }
  }

  res.status(500).json({ error: "All models failed. Last error: " + lastError });
};
