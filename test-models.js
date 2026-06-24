const { GoogleGenAI } = require('@google/genai');
require('dotenv').config({ path: '.env' });

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

async function listModels() {
  try {
    const response = await ai.models.list();
    for await (const model of response) {
      if (model.name.includes("flash")) {
        console.log(model.name);
      }
    }
  } catch (err) {
    console.error("Error listing models:", err.message);
  }
}

listModels();
