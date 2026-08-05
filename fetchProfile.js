const axios = require('axios');

async function fetchProfile() {
  try {
    const res = await axios.get('http://localhost:5000/api/users/swaroopmanade21');
    console.log(JSON.stringify(res.data, null, 2));
  } catch (err) {
    console.error(err.message);
  }
}

fetchProfile();
