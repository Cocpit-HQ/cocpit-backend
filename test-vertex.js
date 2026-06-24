require("dotenv").config();
const { GoogleGenAI } = require("@google/genai");

async function testVertex() {
  try {
    const genAI = new GoogleGenAI({
      vertexai: {
        project: process.env.VERTEX_PROJECT_ID,
        location: process.env.VERTEX_LOCATION,
      }
    });
    
    console.log("Testing Vertex AI connection...");
    console.log("Project:", process.env.VERTEX_PROJECT_ID);
    console.log("Location:", process.env.VERTEX_LOCATION);
    console.log("Credentials path:", process.env.GOOGLE_APPLICATION_CREDENTIALS);
    
    const response = await genAI.models.generateContent({
      model: "gemini-2.5-flash",
      contents: "Say hello world"
    });
    
    console.log("SUCCESS! Response:", response.text);
  } catch (error) {
    console.error("VERTEX AI ERROR:");
    console.error(error);
  }
}

testVertex();
