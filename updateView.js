require('dotenv').config();
const pool = require('./src/core/db/pool');
const query = `
CREATE OR REPLACE VIEW organization_display_profiles AS
SELECT 
    org_id,
    CASE 
        WHEN deletion_execute_at IS NULL AND is_deleted = FALSE AND is_deactivated = FALSE THEN name 
        ELSE 'Deleted Page' 
    END AS name,
    CASE 
        WHEN deletion_execute_at IS NULL AND is_deleted = FALSE AND is_deactivated = FALSE THEN slug 
        ELSE 'deleted_page' 
    END AS slug,
    CASE 
        WHEN deletion_execute_at IS NULL AND is_deleted = FALSE AND is_deactivated = FALSE THEN logo_url 
        ELSE NULL 
    END AS logo_url,
    CASE 
        WHEN deletion_execute_at IS NULL AND is_deleted = FALSE AND is_deactivated = FALSE THEN headline 
        ELSE 'This page has been deactivated' 
    END AS headline,
    entity_type
FROM organizations;

CREATE OR REPLACE VIEW active_organizations AS
SELECT * FROM organizations 
WHERE deletion_execute_at IS NULL AND is_deleted = FALSE AND is_deactivated = FALSE;
`;
pool.query(query).then(() => {
    console.log('View updated successfully.');
    process.exit(0);
}).catch(err => {
    console.error(err);
    process.exit(1);
});
