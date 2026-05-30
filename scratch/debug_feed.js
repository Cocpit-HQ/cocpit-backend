require('dotenv').config();
const pool = require('../src/core/db/pool');
const { generateCandidates } = require('../src/modules/feed/candidates/candidateGenerator');
const feedService = require('../src/modules/feed/feed.service');

async function debugFeed() {
  try {
    const { rows } = await pool.query(`
      SELECT follower_id as user_id 
      FROM followers  
      GROUP BY follower_id 
      ORDER BY count(*) DESC 
      LIMIT 1
    `);
    if (rows.length === 0) {
      console.log('NO USERS WITH FOLLOWS FOUND. DB might be empty or unseeded.');
      return;
    }
    const userId = rows[0].user_id;
    console.log(`Debugging feed for user: ${userId}`);

    console.log('--- Step 1: Raw Candidates ---');
    const raw = await generateCandidates({ userId, pool });
    console.log(`Raw candidates generated: ${raw.length}`);

    if (raw.length > 0) {
      console.log('Sample raw candidate:', JSON.stringify(raw[0], null, 2));
    }

    console.log('\n--- Step 2: Full feedService Pipeline ---');
    // Force cache bypass by passing random cursor
    const response = await feedService.getFeed({ userId, cursor: 'test-bypass-123', limit: 20, pool, context: 'home' });
    console.log(`Final returned items: ${response.data.items.length}`);
    console.log(`Meta:`, response.meta);

  } catch (err) {
    console.error('Debug script failed:', err);
  } finally {
    await pool.end();
    process.exit(0);
  }
}

debugFeed();
