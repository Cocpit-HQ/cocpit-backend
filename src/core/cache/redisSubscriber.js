const Redis = require('ioredis');
const { updateFlagInMemory } = require('../../modules/config/featureFlags.service');
const socketService = require('../infrastructure/socket.service');

// Create a dedicated Redis client for subscribing since it blocks other commands
const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const subscriber = new Redis(redisUrl, {
  maxRetriesPerRequest: null,
  retryStrategy(times) {
    return Math.min(times * 100, 3000);
  }
});

let hasLoggedSubscriberError = false;

subscriber.on('connect', () => {
  console.log('✅ Redis Subscriber connected');
  hasLoggedSubscriberError = false;
});

subscriber.on('error', (err) => {
  if (err.code === 'ECONNREFUSED') {
    if (!hasLoggedSubscriberError) {
      console.warn('⚠️ Redis Subscriber unavailable. Running without pub/sub cache.');
      hasLoggedSubscriberError = true;
    }
  } else {
    console.error('🔥 Redis Subscriber error:', err.message);
  }
});

// Subscribe to channels
subscriber.subscribe('admin:feature_flags', 'admin:users', 'admin:organizations', (err, count) => {
  if (err) {
    console.error('Failed to subscribe to admin channels:', err.message);
  } else {
    console.log(`📡 Subscribed to ${count} channel(s) (including admin channels)`);
  }
});

// Listen for messages
subscriber.on('message', async (channel, message) => {
  try {
    const payload = JSON.parse(message);
    
    if (channel === 'admin:users') {
      if ((payload.action === 'suspended' || payload.action === 'deleted') && payload.userId) {
        console.log(`[Admin Event] User ${payload.userId} ${payload.action}. Force disconnecting sockets...`);
        const disconnectedCount = await socketService.disconnectUser(payload.userId);
        console.log(`[Admin Event] Disconnected ${disconnectedCount} socket(s) for user ${payload.userId}`);
      }
    }
    else if (channel === 'admin:organizations') {
      if (payload.action === 'verification_updated') {
        console.log(`[Admin Event] Organization ${payload.orgId} verification updated to ${payload.status}`);
        // Here you would clear cache or notify organization members in future steps
      }
    }
  } catch (err) {
    console.error(`Failed to process message from ${channel}:`, err.message);
  }
});

module.exports = subscriber;
