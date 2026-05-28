/**
 * seedLocations.js — DEPRECATED (PHASE 7 LOCATION MIGRATION)
 * 
 * NOTE: This script is fully deprecated. We no longer use the static `locations`
 * table or the GeoNames dataset. The system now uses Google Places API dynamically.
 * DO NOT RUN THIS SCRIPT. It remains here only for historical reference.
 */
require("dotenv").config();
const fs = require("fs");
const readline = require("readline");
const path = require("path");
const db = require("../core/db/pool"); // connection pool

const countryMap = {
  IN: "India",
  US: "United States",
  GB: "United Kingdom",
  CA: "Canada",
  AU: "Australia",
  DE: "Germany",
  FR: "France",
  AE: "United Arab Emirates",
  SG: "Singapore",
  ZA: "South Africa"
};

async function seed() {
  const filePath = path.join(__dirname, "../../../cities1000/IN.txt");
  
  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
  }

  const fileStream = fs.createReadStream(filePath);

  console.log("Starting locations seed...");
  
  // Create table and extensions if they do not exist
  await db.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
  await db.query(`
    CREATE TABLE IF NOT EXISTS locations (
      id SERIAL PRIMARY KEY,
      name TEXT,
      city TEXT,
      state TEXT,
      country TEXT,
      latitude FLOAT,
      longitude FLOAT
    );
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_location_name 
    ON locations USING gin (name gin_trgm_ops);
  `);

  console.log("Emptying existing locations to re-seed...");
  await db.query(`TRUNCATE TABLE locations RESTART IDENTITY`);

  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity
  });

  const batch = [];
  const batchSize = 1000;

  for await (const line of rl) {
    const row = line.split("\t");

    if (row[6] !== "P") continue; // only populated places (cities)

    const city = row[2]; // Use asciiname instead of localized name (row[1]) to avoid accents like 'ā'
    const lat = row[4];
    const lon = row[5];
    const countryCode = row[8];
    if (countryCode !== "IN") continue; // only keep India
    
    const state = row[10];

    const country = countryMap[countryCode] || countryCode;

    // Optional: filter out rows with weird characters if we needed, but for now we trust dataset
    const name = `${city}, ${state}, ${country}`;

    batch.push([name, city, state, country, lat, lon]);

    if (batch.length === batchSize) {
      await insertBatch(batch);
      batch.length = 0;
    }
  }

  // Insert any remaining items
  if (batch.length > 0) {
    await insertBatch(batch);
  }

  console.log("✅ Seeding complete");
  process.exit(0);
}


async function insertBatch(batch) {
  const values = batch
    .map(
      (_, i) =>
        `($${i * 6 + 1}, $${i * 6 + 2}, $${i * 6 + 3}, $${i * 6 + 4}, $${i * 6 + 5}, $${i * 6 + 6})`
    )
    .join(",");

  const flat = batch.flat();

  await db.query(
    `INSERT INTO locations(name, city, state, country, latitude, longitude)
     VALUES ${values}`,
    flat
  );
}

seed().catch(err => {
  console.error("Seed failed:", err);
  process.exit(1);
});
