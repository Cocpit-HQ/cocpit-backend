require('dotenv').config(); // Trigger reload
const app = require('./admin.app');
const pool = require('./core/db/pool');

// Health check endpoint for Gateway
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', service: 'admin-api' });
});

const PORT = process.env.ADMIN_PORT || 5001;

async function startServer() {
  // Test and initialize database
  try {
    const res = await pool.query('SELECT NOW()');
    console.log(`[DB] PostgreSQL connected successfully at ${res.rows[0].now}`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS admin_audit_logs (
          log_id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
          user_id UUID,
          action_type VARCHAR(100) NOT NULL,
          description TEXT NOT NULL,
          ip_address VARCHAR(45),
          created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at 
      ON admin_audit_logs(created_at DESC);
    `);
    
    console.log('[DB] Verification: admin_audit_logs table verified.');
  } catch (dbErr) {
    console.error('[DB] Critical: Database connection/verification failed:', dbErr);
    process.exit(1);
  }

  const server = app.listen(PORT, () => {
    console.log(`[Admin API] Server listening on port ${PORT}`);
  });

  // Graceful Shutdown
  const gracefulShutdown = () => {
    console.log('\n[Admin API] Shutting down gracefully...');
    server.close(async () => {
      console.log('[Admin API] Closed out remaining HTTP connections.');
      try {
        if (pool) {
          await pool.end();
          console.log('[Admin API] Database pool closed.');
        }
      } catch (err) {
        console.error('[Admin API] Error closing DB pool:', err);
      }
      process.exit(0);
    });
  };

  process.on('SIGINT', gracefulShutdown);
  process.on('SIGTERM', gracefulShutdown);
}

startServer();
