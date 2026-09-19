module.exports = {
  apps: [
    {
      name: "cocpit-gateway",
      script: "./src/gateway.js",
      instances: 1, // Gateway is lightweight, usually 1 instance is enough to start
      exec_mode: "fork",
      env: {
        NODE_ENV: "production",
        GATEWAY_PORT: 8000,
        MAIN_API_URL: "http://localhost:5000",
        ADMIN_API_URL: "http://localhost:5001"
      }
    },
    {
      name: "cocpit-backend",
      script: "./src/server.js",
      instances: 1, // Can scale later by changing to "max" or >1 with cluster mode
      exec_mode: "fork",
      env: {
        NODE_ENV: "production",
        PORT: 5000
      }
    },
    {
      name: "cocpit-admin-api",
      script: "./src/admin.server.js",
      instances: 1,
      exec_mode: "fork",
      env: {
        NODE_ENV: "production",
        ADMIN_PORT: 5001
      }
    }
  ]
};
