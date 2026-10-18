const pool = require('../core/db/pool');

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool,
};
