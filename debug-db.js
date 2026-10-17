require('dotenv').config();
const pool = require('./src/core/db/pool.js');

async function run() {
    try {
        const res = await pool.query(`
            SELECT column_name, data_type 
            FROM information_schema.columns 
            WHERE table_name = 'organization_verifications';
        `);
        console.log('Columns in organization_verifications:', res.rows);

        const orgs = await pool.query('SELECT org_id, name, verification_status FROM organizations ORDER BY created_at DESC LIMIT 1');
        const orgId = orgs.rows[0].org_id;

        const docs = await pool.query('SELECT * FROM organization_documents WHERE org_id = $1', [orgId]);
        console.log('Docs:', docs.rows);

        const verifs = await pool.query('SELECT * FROM organization_verifications WHERE org_id = $1', [orgId]);
        console.log('Verifs:', verifs.rows);
    } catch(e) {
        console.error('DB Error:', e);
    } finally {
        await pool.end();
    }
}
run();
