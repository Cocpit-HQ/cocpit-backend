require("dotenv").config();
const app = require("./app");

const PORT = process.env.PORT || 5000;

app.listen(5000, '0.0.0.0', () => {
  console.log('Server running on port 5000');
});
