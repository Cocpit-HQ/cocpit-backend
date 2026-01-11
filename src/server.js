require("dotenv").config();
const app = require("./app");
const http = require("http");
const { initSocket } = require("./utils/socket");
const server = http.createServer(app);

const PORT = process.env.PORT || 5000;

app.set("trust proxy", true);
initSocket(server);

app.listen(5000, '0.0.0.0', () => {
  console.log('Server running on port 5000');
});

console.log("CICD Deployment Successful - Version 1.0.1");