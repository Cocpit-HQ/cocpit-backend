const { Pool } = require('pg');
require('dotenv').config({ path: '.env' });

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

const roles = [
    { name: "Software Engineer", category: "Engineering" },
    { name: "Frontend Developer", category: "Engineering" },
    { name: "Backend Developer", category: "Engineering" },
    { name: "Full Stack Developer", category: "Engineering" },
    { name: "Mobile Developer", category: "Engineering" },
    { name: "Data Scientist", category: "Data" },
    { name: "Data Analyst", category: "Data" },
    { name: "Machine Learning Engineer", category: "Engineering" },
    { name: "Product Manager", category: "Product" },
    { name: "Project Manager", category: "Management" },
    { name: "UI/UX Designer", category: "Design" },
    { name: "Product Designer", category: "Design" },
    { name: "Graphic Designer", category: "Design" },
    { name: "Marketing Manager", category: "Marketing" },
    { name: "Digital Marketing Specialist", category: "Marketing" },
    { name: "Sales Representative", category: "Sales" },
    { name: "Account Executive", category: "Sales" },
    { name: "Customer Success Manager", category: "Customer Support" },
    { name: "Human Resources Manager", category: "HR" },
    { name: "Recruiter", category: "HR" },
    { name: "Financial Analyst", category: "Finance" },
    { name: "Accountant", category: "Finance" },
    { name: "Business Analyst", category: "Business" },
    { name: "DevOps Engineer", category: "Engineering" },
    { name: "System Administrator", category: "IT" },
    { name: "Technical Support Specialist", category: "IT" }
];

async function seed() {
    try {
        for (const role of roles) {
            await pool.query(
                `INSERT INTO job_roles_master (role_name, category) 
                 VALUES ($1, $2) 
                 ON CONFLICT (role_name) DO NOTHING`,
                [role.name, role.category]
            );
        }
        console.log("Successfully seeded job roles!");
    } catch (err) {
        console.error("Failed to seed job roles:", err);
    } finally {
        await pool.end();
    }
}

seed();
