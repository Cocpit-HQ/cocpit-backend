const pool = require("./src/db/pool");

async function addAudioColumn() {
    try {
        console.log("Checking if column 'audio_pitch_url' exists in 'job_applications'...");

        // Check if column exists
        const checkRes = await pool.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name='job_applications' AND column_name='audio_pitch_url';
    `);

        if (checkRes.rowCount > 0) {
            console.log("Column 'audio_pitch_url' already exists.");
        } else {
            console.log("Adding column 'audio_pitch_url'...");
            await pool.query(`
            ALTER TABLE job_applications 
            ADD COLUMN audio_pitch_url TEXT;
        `);
            console.log("Column added successfully.");
        }

        process.exit(0);
    } catch (err) {
        console.error("Migration failed:", err);
        process.exit(1);
    }
}

addAudioColumn();
