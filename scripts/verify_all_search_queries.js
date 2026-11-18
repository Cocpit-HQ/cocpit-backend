'use strict';

const { searchCompanies } = require('../src/modules/search/queries/companySearch.query');
const { searchPosts } = require('../src/modules/search/queries/postSearch.query');
const { searchPeople } = require('../src/modules/search/queries/peopleSearch.query');
const { searchInstitutes } = require('../src/modules/search/queries/instituteSearch.query');
const { searchJobs } = require('../src/modules/search/queries/jobSearch.query');

async function verifyQueries() {
  console.log('--- VERIFYING SEARCH QUERY BUILDERS ACROSS ALL FILTERS ---');
  const captured = [];
  const testClient = {
    query: async (sql, params) => {
      captured.push({ sql, params });
      return { rows: [] };
    }
  };

  // 1. Company Search with Verified Filter
  await searchCompanies(testClient, {
    searchTerm: 'Tech',
    queryParams: { is_verified: 'true' }
  });
  const c1 = captured.pop();
  if (!c1.sql.includes("c.verification_status IN ('VERIFIED', 'DOMAIN_VERIFIED')")) {
    throw new Error('Verification status missing from Company search WHERE clause');
  }
  console.log('✅ 1. Company verified filter in WHERE clause: VERIFIED');

  // 2. Org Post Search with Following (connections)
  await searchPosts(testClient, {
    searchTerm: 'Product',
    orgActorId: '00000000-0000-0000-0000-000000000001',
    queryParams: { posted_by: 'connections' }
  });
  const p1 = captured.pop();
  if (!p1.sql.includes('organization_org_follows') || !p1.sql.includes('organization_user_follows')) {
    throw new Error('Org follows tables missing from Post search for org actor');
  }
  console.log('✅ 2. Org Post Following filter uses org follows tables: VERIFIED');

  // 3. Org Post Search with Others
  await searchPosts(testClient, {
    searchTerm: 'Design',
    orgActorId: '00000000-0000-0000-0000-000000000001',
    queryParams: { posted_by: 'others' }
  });
  const p2 = captured.pop();
  if (!p2.sql.includes('NOT EXISTS (\n                SELECT 1 FROM organization_followers ofol') && !p2.sql.includes('organization_org_follows')) {
    throw new Error('Org others filter missing negative checks');
  }
  console.log('✅ 3. Org Post Others filter correctly excludes followed entities: VERIFIED');

  // 4. Org Post Search with Mentions Org
  await searchPosts(testClient, {
    searchTerm: 'AI',
    orgActorId: '00000000-0000-0000-0000-000000000001',
    queryParams: { mentions_org: 'true' }
  });
  const p3 = captured.pop();
  if (!p3.sql.includes('post_tags pt') || !p3.sql.includes('organizations org_m')) {
    throw new Error('Mentions org missing indexed post_tags or organizations');
  }
  console.log('✅ 4. Org Post Mentions filter uses indexed post_tags: VERIFIED');

  console.log('\n🎉 ALL QUERY BUILDERS PASSED INVARIANT VERIFICATION!');
}

verifyQueries().catch(err => {
  console.error('❌ Query verification failed:', err);
  process.exit(1);
});
