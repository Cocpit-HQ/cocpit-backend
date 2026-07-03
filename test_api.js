const axios = require('axios');

async function test() {
  const baseUrl = 'http://localhost:5000/api';
  
  const testIds = ['', 'undefined', 'null', 'd915708f-0777-4d6c-b9aa-a6a6aefaddaf'];
  
  for (const id of testIds) {
    try {
      const res = await axios.get(`${baseUrl}/jobs/${id}`);
      console.log(`GET /jobs/${id} -> Status: ${res.status}`);
    } catch (err) {
      console.log(`GET /jobs/${id} -> Error: ${err.response ? err.response.status : err.message}`);
    }
  }
}

test();
