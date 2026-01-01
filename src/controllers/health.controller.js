const getHealth = (req, res) => {
  const uptime = process.uptime();
  const uptimeHours = Math.floor(uptime / 3600);
  const uptimeMinutes = Math.floor((uptime % 3600) / 60);
  const uptimeSeconds = Math.floor(uptime % 60);

  const formattedUptime = `${uptimeHours}h ${uptimeMinutes}m ${uptimeSeconds}s`;

  res.status(200).json({
    status: "UP",
    uptime: formattedUptime,
    timestamp: new Date().toISOString(),
  });
};

module.exports = {
  getHealth,
};
