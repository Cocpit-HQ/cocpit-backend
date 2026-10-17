const redis = require('../../../core/cache/redis');
const socketService = require('../../../core/infrastructure/socket.service');
const pool = require('../../../core/db/pool');

const getFlags = async (req, res) => {
  try {
    const flags = {};
    try {
      const keys = await redis.keys('feature_flag:*');
      for (const key of keys) {
        const val = await redis.get(key);
        const flagKey = key.replace('feature_flag:', '');
        flags[flagKey] = val === 'true';
      }
    } catch (rErr) {
      console.warn('⚠️ Redis read failed in admin getFlags:', rErr.message);
    }

    try {
      const { rows } = await pool.query('SELECT flag_key, is_enabled FROM feature_flags');
      for (const row of rows) {
        if (flags[row.flag_key] === undefined) {
          flags[row.flag_key] = row.is_enabled;
        }
      }
    } catch (dbErr) {
      console.warn('⚠️ DB read failed in admin getFlags:', dbErr.message);
    }

    // Default teams flag if not yet set
    if (flags.enableTeamsModule === undefined && flags.enableTeams === undefined && flags.teams === undefined) {
      flags.enableTeamsModule = true;
      flags.enableTeams = true;
      flags.teams = true;
    }

    // Default org settings flag if not yet set
    if (flags.enableOrgSettingsModule === undefined && flags.enableOrgSettings === undefined && flags.orgSettings === undefined) {
      flags.enableOrgSettingsModule = true;
      flags.enableOrgSettings = true;
      flags.orgSettings = true;
    }

    // Default org analytics flag if not yet set
    if (flags.enableOrgAnalyticsModule === undefined && flags.enableOrgAnalytics === undefined && flags.orgAnalytics === undefined) {
      flags.enableOrgAnalyticsModule = true;
      flags.enableOrgAnalytics = true;
      flags.orgAnalytics = true;
    }

    // Default org notifications flag if not yet set
    if (flags.enableOrgNotificationsModule === undefined && flags.enableOrgNotifications === undefined && flags.orgNotifications === undefined) {
      flags.enableOrgNotificationsModule = true;
      flags.enableOrgNotifications = true;
      flags.orgNotifications = true;
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

    // Ensure notification flag aliases are kept in sync
    if (itemsToUpdate.enableNotifications !== undefined && itemsToUpdate.enableNotificationsModule === undefined) {
      itemsToUpdate.enableNotificationsModule = itemsToUpdate.enableNotifications;
    } else if (itemsToUpdate.enableNotificationsModule !== undefined && itemsToUpdate.enableNotifications === undefined) {
      itemsToUpdate.enableNotifications = itemsToUpdate.enableNotificationsModule;
    }

    // Ensure team flag aliases are kept in sync
    const teamVal = itemsToUpdate.enableTeamsModule ?? itemsToUpdate.enableTeams ?? itemsToUpdate.teams;
    if (teamVal !== undefined) {
      const boolTeamVal = teamVal === true || teamVal === 'true';
      itemsToUpdate.enableTeamsModule = boolTeamVal;
      itemsToUpdate.enableTeams = boolTeamVal;
      itemsToUpdate.teams = boolTeamVal;
    }

    // Ensure org settings flag aliases are kept in sync
    const orgSettingsVal = itemsToUpdate.enableOrgSettingsModule ?? itemsToUpdate.enableOrgSettings ?? itemsToUpdate.orgSettings ?? itemsToUpdate.org_settings;
    if (orgSettingsVal !== undefined) {
      const boolOrgSettingsVal = orgSettingsVal === true || orgSettingsVal === 'true';
      itemsToUpdate.enableOrgSettingsModule = boolOrgSettingsVal;
      itemsToUpdate.enableOrgSettings = boolOrgSettingsVal;
      itemsToUpdate.orgSettings = boolOrgSettingsVal;
    }

    // Ensure org analytics flag aliases are kept in sync
    const orgAnalyticsVal = itemsToUpdate.enableOrgAnalyticsModule ?? itemsToUpdate.enableOrgAnalytics ?? itemsToUpdate.orgAnalytics ?? itemsToUpdate.org_analytics;
    if (orgAnalyticsVal !== undefined) {
      const boolOrgAnalyticsVal = orgAnalyticsVal === true || orgAnalyticsVal === 'true';
      itemsToUpdate.enableOrgAnalyticsModule = boolOrgAnalyticsVal;
      itemsToUpdate.enableOrgAnalytics = boolOrgAnalyticsVal;
      itemsToUpdate.orgAnalytics = boolOrgAnalyticsVal;
    }

    // Ensure org notifications flag aliases are kept in sync
    const orgNotificationsVal = itemsToUpdate.enableOrgNotificationsModule ?? itemsToUpdate.enableOrgNotifications ?? itemsToUpdate.orgNotifications ?? itemsToUpdate.org_notifications;
    if (orgNotificationsVal !== undefined) {
      const boolOrgNotificationsVal = orgNotificationsVal === true || orgNotificationsVal === 'true';
      itemsToUpdate.enableOrgNotificationsModule = boolOrgNotificationsVal;
      itemsToUpdate.enableOrgNotifications = boolOrgNotificationsVal;
      itemsToUpdate.orgNotifications = boolOrgNotificationsVal;
    }

    let redisFailed = false;
    const updated = [];
    const broadcastPayload = {};
    for (const [k, v] of Object.entries(itemsToUpdate)) {
      if (v !== undefined && v !== null) {
        const strVal = String(v);
        const boolVal = v === true || v === 'true';

        // Upsert into PostgreSQL DB
        await pool.query(
          `INSERT INTO feature_flags (flag_key, is_enabled, updated_at) 
           VALUES ($1, $2, now()) 
           ON CONFLICT (flag_key) DO UPDATE SET is_enabled = EXCLUDED.is_enabled, updated_at = now()`,
          [k, boolVal]
        );

        updated.push({ key: k, value: boolVal });
        broadcastPayload[k] = boolVal;

        try {
          await redis.set(`feature_flag:${k}`, strVal);
          await redis.publish('admin:feature_flags', JSON.stringify({
            action_taken: 'updated',
            key: k,
            value: boolVal
          }));
        } catch (redisErr) {
          console.warn(`⚠️ Redis failed during flag update for ${k}:`, redisErr.message);
          redisFailed = true;
        }
      }
    }
    
    try {
      if (Object.keys(broadcastPayload).length > 0) {
        socketService.broadcastGlobal('feature_flags_updated', broadcastPayload);
      }
    } catch (socketErr) {
      console.warn('⚠️ Socket broadcast failed:', socketErr.message);
      redisFailed = true; // Treating socket failure same as redis failure for warning purposes
    }
    
    if (redisFailed) {
      return res.json({ 
        success: true, 
        message: `${updated.length} flag(s) saved to database, but real-time broadcast failed. Active users may need to refresh.`, 
        data: updated,
        warning: 'Redis or WebSocket failure'
      });
    }

    res.json({ success: true, message: `${updated.length} flag(s) updated successfully`, data: updated });
  } catch (error) {
    console.error('Error updating flag:', error);
    res.status(500).json({ success: false, message: 'Failed to update flag' });
  }
};

module.exports = { getFlags, updateFlag };
