const fs = require('fs');
let content = fs.readFileSync('schema.sql', 'utf8');

content = content.replace(/\s*location_id INT,[\s\S]*?(?=about_text)/, '\n    ');
content = content.replace(/\s*-- ---------------------------------------------------------\n\s*-- LOCATIONS AUTOCOMPLETE[\s\S]*?idx_users_location_id ON users\(location_id\);\n/, '\n');

fs.writeFileSync('schema.sql', content);
console.log('schema.sql updated');
