const redis = require('../../../core/cache/redis');

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
    const { key, value, features, flags } = req.body;
    const itemsToUpdate = features || flags || (key !== undefined ? { [key]: value } : null);

    if (!itemsToUpdate || typeof itemsToUpdate !== 'object') {
      return res.status(400).json({ success: false, message: 'Invalid payload: key/value or features object required' });
    }

    const updated = [];
    for (const [k, v] of Object.entries(itemsToUpdate)) {
      if (v !== undefined && v !== null) {
        const strVal = String(v);
        const boolVal = v === true || v === 'true';
        await redis.set(`feature_flag:${k}`, strVal);
        await redis.publish('admin:feature_flags', JSON.stringify({
          action_taken: 'updated',
          key: k,
          value: boolVal
        }));
        updated.push({ key: k, value: boolVal });
      }
    }
    
    res.json({ success: true, message: `${updated.length} flag(s) updated successfully`, data: updated });
  } catch (error) {
    console.error('Error updating flag:', error);
    res.status(500).json({ success: false, message: 'Failed to update flag' });
  }
};

module.exports = { getFlags, updateFlag };
