const redis = require('../../core/cache/redis');

const getFlags = async (req, res) => {
  try {
    const keys = await redis.keys('feature_flag:*');
    const flags = {};
    for (const key of keys) {
      const val = await redis.get(key);
      const flagKey = key.replace('feature_flag:', '');
      flags[flagKey] = val === 'true';
    }
    res.json({ success: true, data: flags });
  } catch (error) {
    console.error('Error fetching flags:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch flags' });
  }
};

const updateFlag = async (req, res) => {
  try {
    const { key, value } = req.body;
    if (!key || value === undefined) {
      return res.status(400).json({ success: false, message: 'Key and value are required' });
    }
    
    await redis.set(`feature_flag:${key}`, String(value));
    
    // Publish update to Redis Pub/Sub channel
    await redis.publish('admin:feature_flags', JSON.stringify({
      action_taken: 'updated',
      key,
      value: Boolean(value)
    }));
    
    res.json({ success: true, message: `Flag ${key} updated successfully`, data: { key, value } });
  } catch (error) {
    console.error('Error updating flag:', error);
    res.status(500).json({ success: false, message: 'Failed to update flag' });
  }
};

module.exports = { getFlags, updateFlag };
