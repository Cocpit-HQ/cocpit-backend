const fs = require('fs');
const path = require('path');

function walk(dir, done) {
  let results = [];
  fs.readdir(dir, function(err, list) {
    if (err) return done(err);
    let pending = list.length;
    if (!pending) return done(null, results);
    list.forEach(function(file) {
      file = path.resolve(dir, file);
      fs.stat(file, function(err, stat) {
        if (stat && stat.isDirectory()) {
          walk(file, function(err, res) {
            results = results.concat(res);
            if (!--pending) done(null, results);
          });
        } else {
          results.push(file);
          if (!--pending) done(null, results);
        }
      });
    });
  });
}

walk(path.join(__dirname, 'src/admin/modules'), (err, files) => {
  if (err) throw err;
  files.forEach(file => {
    if (file.endsWith('.js')) {
      let content = fs.readFileSync(file, 'utf8');
      let newContent = content.replace(/require\('\.\.\/\.\.\/core\//g, "require('../../../core/");
      newContent = newContent.replace(/require\('\.\.\/utils\//g, "require('../../utils/");
      newContent = newContent.replace(/require\('\.\.\/middlewares\//g, "require('../../middlewares/");
      if (content !== newContent) {
        fs.writeFileSync(file, newContent);
        console.log('Fixed:', file);
      }
    }
  });
});
