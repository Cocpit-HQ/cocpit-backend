"use strict";

const SYSTEM_INSTRUCTION = `You are an expert ATS (Applicant Tracking System) parser. Your job is to extract structured information from a candidate's resume and return it strictly as JSON.

RULES:
1. ONLY extract Personal Information, Work Experience, Education, and Skills.
2. DO NOT extract projects or tasks as separate work experiences. Projects listed under a job should be summarized in that job's 'description'. Every work experience must represent a distinct employment period with a company.
3. DO NOT perform matching, scoring, or recommendations.
4. DO NOT hallucinate or infer information not explicitly stated in the resume.
5. If a field is missing in the resume, leave it as null, empty string, or empty array according to the schema.
6. Extract only what is requested in the JSON schema.
7. Return purely the JSON object without any markdown formatting, conversational text, or explanations.`;

const RESUME_JSON_SCHEMA = {
  type: "object",
  properties: {
    profile: {
      type: "object",
      properties: {
        fullName: { type: "string", description: "Candidate's full name." },
        accountName: { type: "string", description: "A generated account name based on the full name (e.g., john_doe)." }
      }
    },
    workExperience: {
      type: "array",
      items: {
        type: "object",
        properties: {
          companyName: { type: "string", description: "Company name." },
          jobTitle: { type: "string", description: "Job title." },
          location: { type: "string", description: "Location of the job." },
          startDate: { type: "string", description: "Start date (YYYY-MM-DD or MM/YYYY)." },
          endDate: { type: "string", description: "End date (YYYY-MM-DD or MM/YYYY), or null if current." },
          description: { type: "string", description: "Brief description of responsibilities." }
        }
      }
    },
    education: {
      type: "array",
      items: {
        type: "object",
        properties: {
          schoolName: { type: "string", description: "School or university name." },
          degree: { type: "string", description: "Degree obtained (e.g., B.S., Master's)." },
          fieldOfStudy: { type: "string", description: "Major or field of study." },
          location: { type: "string", description: "Location of the school." },
          startDate: { type: "string", description: "Start date (YYYY-MM-DD or MM/YYYY)." },
          endDate: { type: "string", description: "End date (YYYY-MM-DD or MM/YYYY), or null if currently attending." }
        }
      }
    },
    skills: {
      type: "array",
      items: {
        type: "string"
      },
      description: "List of technical and soft skills extracted. Return a maximum of 14 most relevant skills."
    }
  },
  required: ["profile", "workExperience", "education", "skills"]
};

const buildPrompt = (resumeText) => {
  return `Extract the requested information from the following resume text:\n\n${resumeText}\n\nReturn strictly valid JSON matching the provided schema.`;
};

module.exports = {
  SYSTEM_INSTRUCTION,
  RESUME_JSON_SCHEMA,
  buildPrompt
};
