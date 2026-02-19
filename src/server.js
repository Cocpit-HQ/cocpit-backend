require("dotenv").config();
// Server Entry Point
const app = require("./app");
const http = require("http");
const { initSocket } = require("./utils/socket");
const { startSessionTimeoutWorker } = require("./workers/sessionTimeoutWorker");
const server = http.createServer(app);

const PORT = process.env.PORT || 5000;

app.set("trust proxy", true);
initSocket(server);
startSessionTimeoutWorker();

server.listen(PORT, '0.0.0.0', () => {
  console.log('Server running on port ' + PORT);
});

console.log("CICD Deployment Successful - Version 1.0.1");