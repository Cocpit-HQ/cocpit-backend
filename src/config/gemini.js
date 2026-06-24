const { GoogleGenAI } = require("@google/genai");

if (!process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEY === "your_gemini_api_key_here") {
  console.warn("⚠️  GEMINI_API_KEY is not set. AI Job Description generation will be unavailable.");
}

const genAI = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
});

module.exports = genAI;
