require('dotenv').config();
const pool = require('./src/core/db/pool');
const redis = require('./src/core/cache/redis');
const { generateCandidates } = require('./src/modules/feed/candidates/candidateGenerator');
const { rankCandidates } = require('./src/modules/feed/ranking/rankingCalculator');
const { rerankCandidates } = require('./src/modules/feed/reranking/rerankingEngine');

async function testDay2Pipeline() {
  console.log('--- COCPIT Feed Day 2 Pipeline Test ---');

  try {
    // 1. Get a test user ID from the database
    // We'll pick a user who follows some organizations or users to get a good candidate pool
    const { rows } = await pool.query('SELECT user_id, full_name FROM users ORDER BY created_at ASC LIMIT 1');
    
    if (rows.length === 0) {
      console.log('❌ No users found in database to test with.');
      process.exit(1);
    }

    const testUser = rows[0];
    const userId = testUser.user_id;
    console.log(`\nTesting pipeline for User: ${testUser.full_name} (${userId})`);

    // 2. Candidate Generation (Orchestrator)
    console.log('\n▶️ STEP 1: Candidate Generation (fetching from all 4 sources)...');
    console.time('Generation Time');
    const candidates = await generateCandidates({
      userId,
      pool,
      limit: 100,
      skipCache: true // Force DB queries for the test
    });
    console.timeEnd('Generation Time');
    
    console.log(`✅ Generated ${candidates.length} deduplicated candidates.`);
    
    if (candidates.length === 0) {
      console.log('⚠️ No candidates found for this user. The DB might be empty or missing connections/posts.');
      process.exit(0);
    }

    // Print breakdown of sources
    const sourcesCount = candidates.reduce((acc, c) => {
      acc[c.source] = (acc[c.source] || 0) + 1;
      return acc;
    }, {});
    console.log('Source Breakdown:', sourcesCount);

    // 3. Ranking Engine
    console.log('\n▶️ STEP 2: Ranking Engine (applying formulas and signal registry)...');
    console.time('Ranking Time');
    const ranked = await rankCandidates(candidates, userId, pool);
    console.timeEnd('Ranking Time');

    console.log(`✅ Ranked ${ranked.length} candidates. Top candidate score: ${ranked[0].final_score}`);
    console.log('Top Candidate Breakdown:', ranked[0].score_breakdown);

    // 4. Reranking / Diversity
    console.log('\n▶️ STEP 3: Reranking Engine (applying diversity penalties & seen filtering)...');
    console.time('Reranking Time');
    const finalFeed = await rerankCandidates(ranked, userId);
    console.timeEnd('Reranking Time');

    console.log(`✅ Reranked output: ${finalFeed.length} candidates remaining after seen-set filter.`);
    
    if (finalFeed.length > 0) {
        console.log('\n--- TOP 3 FINAL FEED ITEMS ---');
        finalFeed.slice(0, 3).forEach((item, index) => {
            console.log(`${index + 1}. Item Type: ${item._candidate.itemType} | Source: ${item._candidate.source} | Final Score: ${item.final_score.toFixed(4)} | Breakdown:`, item.score_breakdown);
        });
    }

    console.log('\n🎉 Day 2 Pipeline executed successfully end-to-end!');

  } catch (err) {
    console.error('\n❌ Pipeline Test Failed:', err);
  } finally {
    // Cleanup connections to allow script to exit gracefully
    console.log('\nCleaning up connections...');
    try {
      if (pool && pool.end) await pool.end();
      if (redis && redis.quit) await redis.quit();
    } catch (cleanupErr) {
      console.log('Cleanup error (non-fatal):', cleanupErr.message);
    }
    process.exit(0);
  }
}

testDay2Pipeline();
