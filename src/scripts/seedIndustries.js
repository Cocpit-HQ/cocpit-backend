const { Pool } = require('pg');
require('dotenv').config({ path: '.env' });

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

const industries = [
  "Accounting", "Airlines/Aviation", "Alternative Dispute Resolution", "Alternative Medicine", "Animation", "Apparel & Fashion", "Architecture & Planning", "Arts and Crafts", "Automotive", "Aviation & Aerospace",
  "Banking", "Biotechnology", "Broadcast Media", "Building Materials", "Business Supplies and Equipment", "Capital Markets", "Chemicals", "Civic & Social Organization", "Civil Engineering", "Commercial Real Estate",
  "Computer & Network Security", "Computer Games", "Computer Hardware", "Computer Networking", "Computer Software", "Construction", "Consumer Electronics", "Consumer Goods", "Consumer Services", "Cosmetics",
  "Cybersecurity", "Cloud Computing", "AI & Machine Learning", "Data Science & Analytics", "IT Services and IT Consulting", "Software Development",
  "Dairy", "Defense & Space", "Design", "Education Management", "E-Learning", "Electrical/Electronic Manufacturing", "Entertainment", "Environmental Services", "Events Services", "Executive Office",
  "Facilities Services", "Farming", "Financial Services", "Fine Art", "Fishery", "Food & Beverages", "Food Production", "Fund-Raising", "Furniture", "Gambling & Casinos",
  "Glass, Ceramics & Concrete", "Government Administration", "Government Relations", "Graphic Design", "Health, Wellness and Fitness", "Higher Education", "Hospital & Health Care", "Hospitality", "Human Resources", "Import and Export",
  "Individual & Family Services", "Industrial Automation", "Information Services", "Information Technology and Services", "Insurance", "International Affairs", "International Trade and Development", "Internet", "Investment Banking", "Investment Management",
  "Judiciary", "Law Enforcement", "Law Practice", "Legal Services", "Legislative Office", "Leisure, Travel & Tourism", "Libraries", "Logistics and Supply Chain", "Luxury Goods & Jewelry", "Machinery",
  "Management Consulting", "Maritime", "Market Research", "Marketing and Advertising", "Mechanical or Industrial Engineering", "Media Production", "Medical Devices", "Medical Practice", "Mental Health Care", "Military",
  "Mining & Metals", "Motion Pictures and Film", "Museums and Institutions", "Music", "Nanotechnology", "Newspapers", "Non-Profit Organization Management", "Oil & Energy", "Online Media", "Outsourcing/Offshoring",
  "Package/Freight Delivery", "Packaging and Containers", "Paper & Forest Products", "Performing Arts", "Pharmaceuticals", "Philanthropy", "Photography", "Plastics", "Political Organization", "Primary/Secondary Education",
  "Printing", "Professional Training & Coaching", "Program Development", "Public Policy", "Public Relations and Communications", "Public Safety", "Publishing", "Railroad Manufacture", "Ranching", "Real Estate",
  "Recreational Facilities and Services", "Religious Institutions", "Renewables & Environment", "Research", "Restaurants", "Retail", "Security and Investigations", "Semiconductors", "Shipbuilding", "Sporting Goods",
  "Sports", "Staffing and Recruiting", "Supermarkets", "Telecommunications", "Textiles", "Think Tanks", "Tobacco", "Translation and Localization", "Transportation/Trucking/Railroad", "Utilities",
  "Venture Capital & Private Equity", "Veterinary", "Warehousing", "Wholesale", "Wine and Spirits", "Wireless", "Writing and Editing", "Other"
];

async function seed() {
    try {
        console.log('Creating industries_master table if it does not exist...');
        await pool.query(`
            CREATE TABLE IF NOT EXISTS industries_master (
                industry_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                industry_name VARCHAR(255) UNIQUE NOT NULL,
                created_at TIMESTAMPTZ DEFAULT now()
            );
            CREATE INDEX IF NOT EXISTS idx_industries_name ON industries_master (industry_name);
        `);

        console.log(`Seeding ${industries.length} industries...`);
        for (const industry of industries) {
            await pool.query(
                `INSERT INTO industries_master (industry_name) 
                 VALUES ($1) 
                 ON CONFLICT (industry_name) DO NOTHING`,
                [industry]
            );
        }
        console.log("Successfully seeded industries!");
    } catch (err) {
        console.error("Failed to seed industries:", err);
    } finally {
        await pool.end();
    }
}

seed();
