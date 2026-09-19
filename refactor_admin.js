const fs = require('fs');
const path = require('path');

const updateRequires = (dir) => {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const fullPath = path.join(dir, file);
    if (fs.statSync(fullPath).isDirectory()) {
      updateRequires(fullPath);
    } else if (fullPath.endsWith('.js')) {
      let content = fs.readFileSync(fullPath, 'utf8');
      let changed = false;
      
      // Fix imports for `const { pool } = require(...)`
      if (content.includes("const { pool } = require('../config/db')")) {
         content = content.replace(/const { pool } = require\('\.\.\/config\/db'\)/g, "const pool = require('../../core/db/pool')");
         changed = true;
      }
      if (content.includes("const { pool } = require('../../config/db')")) {
         content = content.replace(/const { pool } = require\('\.\.\/\.\.\/config\/db'\)/g, "const pool = require('../../../core/db/pool')");
         changed = true;
      }
      
      if (content.includes("require('../config/db')")) {
        content = content.replace(/require\('\.\.\/config\/db'\)/g, "require('../../core/db/pool')");
        changed = true;
      }
      if (content.includes('require("../config/db")')) {
        content = content.replace(/require\("\.\.\/config\/db"\)/g, "require('../../core/db/pool')");
        changed = true;
      }
      if (content.includes("require('../../config/db')")) {
         content = content.replace(/require\('\.\.\/\.\.\/config\/db'\)/g, "require('../../../core/db/pool')");
         changed = true;
      }
      
      if (changed) {
        fs.writeFileSync(fullPath, content);
        console.log('Updated ' + fullPath);
      }
    }
  }
};

updateRequires('./src/admin');
if (fs.existsSync('./src/admin/server.js')) fs.unlinkSync('./src/admin/server.js');
if (fs.existsSync('./src/admin/config')) fs.rmSync('./src/admin/config', { recursive: true, force: true });
console.log('Cleanup complete.');
