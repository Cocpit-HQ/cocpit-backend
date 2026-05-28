const fs = require('fs');

let content = fs.readFileSync('schema.sql', 'utf8');

// Remove location_id from users table
content = content.replace(/\s*location_id\s+INT[^,]*,?/g, '');

// Remove locations table block completely
const locationBlockRegex = /-- \-+\n-- LOCATIONS AUTOCOMPLETE\n-- \-+[\s\S]*?CREATE INDEX idx_users_location_id ON users\(location_id\);/g;
content = content.replace(locationBlockRegex, '');

// Append new indexes if they aren't already there
if (!content.includes('idx_users_location_country')) {
    content += `\nCREATE INDEX IF NOT EXISTS idx_users_location_country ON users(location_country) WHERE location_country IS NOT NULL;\n`;
}
if (!content.includes('idx_users_location_city')) {
    content += `\nCREATE INDEX IF NOT EXISTS idx_users_location_city ON users(LOWER(location_city)) WHERE location_city IS NOT NULL;\n`;
}

fs.writeFileSync('schema.sql', content);
console.log('Fixed schema.sql');
