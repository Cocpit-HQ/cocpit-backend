"use strict";

const SYSTEM_INSTRUCTION = `You are an expert ATS (Applicant Tracking System) parser. Your job is to extract structured information from a candidate's resume and return it strictly as JSON.

RULES:
1. ONLY extract Personal Information, Work Experience, Education, and Skills.
2. DO NOT extract projects or tasks as separate work experiences. Projects listed under a job should be summarized in that job's 'description'. Every work experience must represent a distinct employment period with a company.
3. DO NOT perform matching, scoring.
4. DO NOT hallucinate or infer info not explicitly stated in the resume.
5. If a field is missing in the resume, leave it as null, empty string, empty array according to the schema.
6. Extract only what is requested in the JSON schema.
7. Return purely the JSON object without any markdown formatting or explanations.
8. SKILLS EXTRACTION: Extract skills ONLY from dedicated skill sections (e.g., "Skills", "Technical Skills", "Core Competencies", "Areas of Expertise"). Format skill names in Title Case (capitalize the first letter of each word). DO NOT extract or infer skills from work experience descriptions. IGNORE any skills enclosed in brackets(e.g., from "AWS (EC2, S3)" extract ONLY "AWS", do NOT extract "EC2" or "S3").
9. DATES: Extract dates formatted strictly as YYYY-MM-DD or MM/YYYY. If a date is missing, unknown, or unclear, leave it strictly as null. NEVER output placeholder or zeroed dates like "0000", "0000-00", "00/0000", or "0000-00-00".`;

const RESUME_JSON_SCHEMA = {
  type: "object",
  properties: {
    profile: {
      type: "object",
      properties: {
        fullName: { type: "string", description: "Candidate's full name." },
        accountName: { type: "string", description: "A generated account name based on the full name (e.g., john_doe). Must only contain lowercase letters (a-z), numbers (0-9), dots (.), and underscores (_). No spaces, uppercase letters, or other special characters." }
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
          startDate: { type: "string", description: "Start date (YYYY-MM-DD or MM/YYYY). If unknown, missing, or if only a single date or year is provided for this entry, leave this as null. Never output placeholder values like '0000' or '0000-00'." },
          endDate: { type: "string", description: "End date (YYYY-MM-DD or MM/YYYY). If currently employed, unknown, or missing, leave this as null. If only a single date/year is provided, put it here. Never output placeholder values like '0000' or '0000-00'." },
          description: { type: "string", description: "Brief description of responsibilities (maximum 1400 characters)." }
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
          startDate: { type: "string", description: "Start date (YYYY-MM-DD or MM/YYYY). If unknown, missing, or if only a single date or year is provided for this entry, leave this as null. Never output placeholder values like '0000' or '0000-00'." },
          endDate: { type: "string", description: "End date (YYYY-MM-DD or MM/YYYY). If currently attending, unknown, or missing, leave this as null. If only a single date/year is provided, put it here. Never output placeholder values like '0000' or '0000-00'." }
        }
      }
    },
    skills: {
      type: "array",
      items: {
        type: "string"
      },
      description: "List of technical and soft skills extracted ONLY from dedicated skill sections (e.g., 'Skills', 'Core Competencies'). DO NOT extract inferred skills from work experience. IGNORE any text or skills enclosed in brackets. Return a maximum of 7 most relevant skills."
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
