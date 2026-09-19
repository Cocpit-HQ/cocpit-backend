require('dotenv').config();
const feedController = require('./src/admin/modules/feed/feed.controller');
async function run() {
  const req = { params: { id: 'eb1ea2ab-bcd0-482c-951f-f41a8625bcea' } };
  const res = {
    status: (code) => ({
      json: (data) => console.log(`STATUS ${code}:`, data)
    }),
    json: (data) => console.log('JSON:', data)
  };
  await feedController.getChannelArticles(req, res);
  process.exit(0);
}
run();
