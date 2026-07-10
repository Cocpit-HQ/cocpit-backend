const pool = require('../../core/db/pool');
const redis = require('../../core/cache/redis');

exports.getUserRoles = async (req, res) => {
  try {
    const query = `
      SELECT DISTINCT account_type AS role FROM profiles WHERE account_type IS NOT NULL
      UNION
      SELECT DISTINCT user_type AS role FROM users WHERE user_type IS NOT NULL
      ORDER BY role
    `;
    const result = await pool.query(query);
    res.json(result.rows.map(row => row.role));
  } catch (err) {
    console.error('Error fetching user roles:', err);
    res.status(500).json({ error: 'Server error fetching roles' });
  }
};

exports.getUsers = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 8; // Match frontend's 8 items per page
    const offset = (page - 1) * limit;
    
    const search = req.query.search || '';
    const status = req.query.status || 'All';
    const roleFilter = req.query.role || 'All';

    let baseQuery = 'FROM users u LEFT JOIN profiles p ON u.user_id = p.user_id WHERE 1=1';
    let queryParams = [];
    
    // Status Filter
    if (status !== 'All') {
      if (status === 'Active') {
        baseQuery += ' AND u.is_suspended = false AND u.is_deleted = false';
      } else if (status === 'Suspended') {
        baseQuery += ' AND u.is_suspended = true';
      } else if (status === 'Deleted') {
        baseQuery += ' AND u.is_deleted = true';
      }
    }

    // Role Filter
    if (roleFilter !== 'All') {
      queryParams.push(roleFilter);
      const roleParamIndex = queryParams.length;
      baseQuery += ` AND COALESCE(p.account_type, u.user_type, 'Working Professional') = $${roleParamIndex}`;
    }

    // Search Filter
    if (search) {
      queryParams.push(`%${search}%`);
      const searchParamIndex = queryParams.length;
      baseQuery += ` AND (u.email ILIKE $${searchParamIndex} OR u.full_name ILIKE $${searchParamIndex})`;
    }

    // Get Total Count for Pagination
    const countQuery = `SELECT COUNT(*) ${baseQuery}`;
    const countResult = await pool.query(countQuery, queryParams);
    const total = parseInt(countResult.rows[0].count);
    const totalPages = Math.ceil(total / limit) || 1;

    // Get Overall Stats for Cards
    const statsQuery = `
      SELECT 
        COUNT(*) as total_users,
        COUNT(*) FILTER (WHERE is_suspended = false AND is_deleted = false) as active_users,
        COUNT(*) FILTER (WHERE is_suspended = true) as suspended_users
      FROM users
    `;
    const statsResult = await pool.query(statsQuery);
    const stats = {
      totalUsers: parseInt(statsResult.rows[0].total_users),
      activeUsers: parseInt(statsResult.rows[0].active_users),
      suspendedUsers: parseInt(statsResult.rows[0].suspended_users),
    };

    // Get Paginated Data
    const dataQuery = `
      SELECT 
        u.user_id,
        u.full_name,
        u.email,
        u.user_type,
        p.account_type,
        u.is_suspended,
        u.is_deleted,
        u.avatar_url
      ${baseQuery}
      ORDER BY u.created_at DESC
      LIMIT $${queryParams.length + 1} OFFSET $${queryParams.length + 2}
    `;
    
    const paginatedParams = [...queryParams, limit, offset];
    const { rows } = await pool.query(dataQuery, paginatedParams);

    const formattedUsers = rows.map(user => {
      // Calculate initials
      let initials = 'U';
      if (user.full_name) {
        const parts = user.full_name.trim().split(' ');
        if (parts.length > 1) {
          initials = (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
        } else if (parts.length === 1 && parts[0]) {
          initials = parts[0].substring(0, 2).toUpperCase();
        }
      }

      // Determine status
      let userStatus = 'Active';
      if (user.is_deleted) {
        userStatus = 'Deleted';
      } else if (user.is_suspended) {
        userStatus = 'Suspended';
      }

      // Map user_type to role if needed (default to Working Professional if missing)
      const role = user.account_type || user.user_type || 'Working Professional';

      return {
        id: user.user_id,
        initials,
        name: user.full_name,
        email: user.email,
        role: role,
        status: userStatus,
        avatar: user.avatar_url
      };
    });

    res.json({
      data: formattedUsers,
      total,
      page,
      totalPages,
      limit,
      stats
    });
  } catch (error) {
    console.error('Error fetching users:', error);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
};

exports.getUserDetails = async (req, res) => {
  try {
    const { id } = req.params;
    
    // 1. Basic User Info
    const userQuery = `
      SELECT user_id, full_name, email, mobile_number, 
             location_formatted, location_city, location_state, location_country, location,
             location_lat, location_lng,
             avatar_url, created_at, user_type, is_suspended, is_deleted, last_active_at, moderation_flags,
             suspension_count
      FROM users WHERE user_id = $1
    `;
    const userResult = await pool.query(userQuery, [id]);
    
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    const user = userResult.rows[0];

    // 2. Stats
    const statsQuery = `
      SELECT 
        (SELECT count(*) FROM posts WHERE author_id = $1) as posts_count,
        (SELECT count(*) FROM followers WHERE following_id = $1) as followers_count,
        (SELECT count(*) FROM followers WHERE follower_id = $1) as following_count,
        (SELECT count(*) FROM reports WHERE target_id = $1) as flags_count
    `;
    const statsResult = await pool.query(statsQuery, [id]);
    const stats = statsResult.rows[0];

    // 3. Activity Feed
    const activityQuery = `
      SELECT id, action_type, entity_type, created_at 
      FROM user_activity_log 
      WHERE user_id = $1 
      ORDER BY created_at DESC 
      LIMIT 15
    `;
    const activityResult = await pool.query(activityQuery, [id]);

    // 4. Linked Accounts
    const socialQuery = `
      SELECT provider FROM user_social_accounts WHERE user_id = $1
    `;
    const socialResult = await pool.query(socialQuery, [id]);

    // 5. Action History (Warnings)
    const warningsQuery = `
      SELECT id, reason, message, is_severe, created_at 
      FROM user_warnings 
      WHERE user_id = $1 
      ORDER BY created_at DESC
    `;
    const warningsResult = await pool.query(warningsQuery, [id]);

    // Formatting status and role
    let status = 'Active';
    if (user.is_deleted) status = 'Deleted';
    else if (user.is_suspended) status = 'Suspended';
    const role = user.user_type || 'Working Professional';

    // Location Formatting
    let formattedLocation = user.location_formatted || user.location;
    if (!formattedLocation && (user.location_city || user.location_state || user.location_country)) {
      formattedLocation = [user.location_city, user.location_state, user.location_country]
        .filter(Boolean)
        .join(', ');
    }

    const profileData = {
      id: user.user_id,
      name: user.full_name,
      email: user.email,
      phone: user.mobile_number,
      location: formattedLocation || 'Unknown',
      coordinates: { lat: user.location_lat, lng: user.location_lng },
      avatar: user.avatar_url,
      joined: user.created_at,
      lastActive: user.last_active_at,
      status: status,
      role: role,
      stats: {
        posts: parseInt(stats.posts_count),
        followers: parseInt(stats.followers_count),
        following: parseInt(stats.following_count),
        flags: parseInt(stats.flags_count),
        moderation_flags: parseInt(user.moderation_flags || 0)
      },
      activities: activityResult.rows,
      actionHistory: warningsResult.rows,
      socialAccounts: socialResult.rows.map(r => r.provider),
      suspensionCount: parseInt(user.suspension_count || 0)
    };

    res.json(profileData);
  } catch (error) {
    console.error('Error fetching user details:', error);
    res.status(500).json({ error: 'Failed to fetch user details' });
  }
};

exports.warnUser = async (req, res) => {
  try {
    const { id } = req.params;
    const { reason, message, isSevere } = req.body;
    
    if (!reason || !reason.trim()) {
      return res.status(400).json({ error: 'Warning reason is required.' });
    }
    
    // Increment moderation flags by 1 if severe
    let points = 0;
    if (isSevere) {
      points = 1;
    }
    
    // Insert into user_warnings
    await pool.query(
      'INSERT INTO user_warnings (user_id, reason, message, is_severe) VALUES ($1, $2, $3, $4)',
      [id, reason, message, isSevere]
    );

    // Increment moderation flags
    const updateQuery = `
      UPDATE users 
      SET moderation_flags = COALESCE(moderation_flags, 0) + $2 
      WHERE user_id = $1 
      RETURNING moderation_flags, full_name
    `;
    const result = await pool.query(updateQuery, [id, points]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    const newFlagsCount = parseInt(result.rows[0].moderation_flags);
    const targetName = result.rows[0].full_name || 'user';
    const adminId = req.user.userId;
    let autoSuspended = false;
    
    if (newFlagsCount >= 7) {
      // Suspend and reset flags to 0
      await pool.query(
        'UPDATE users SET is_suspended = true, suspension_count = COALESCE(suspension_count, 0) + 1, moderation_flags = 0 WHERE user_id = $1',
        [id]
      );
      autoSuspended = true;
      // Log suspension
      await pool.query(
        'INSERT INTO admin_audit_logs (user_id, action_type, description) VALUES ($1, $2, $3)',
        [adminId, 'USER_SUSPENDED', `Automatically suspended ${targetName} due to exceeding 7 moderation flags.`]
      );
      
      // Notify Main API to kill active sessions and blacklist token
      await redis.publish('admin:users', JSON.stringify({ action: 'suspended', userId: id }));
      await redis.setex(`suspended_user:${id}`, 7 * 24 * 60 * 60, 'true'); // 7 days TTL
    }
    
    // Log the warning action to audit logs
    const actionDesc = isSevere 
      ? `Issued a SEVERE warning to ${targetName} for: ${reason}`
      : `Issued a warning to ${targetName} for: ${reason}`;
    await pool.query(
      'INSERT INTO admin_audit_logs (user_id, action_type, description) VALUES ($1, $2, $3)',
      [adminId, 'USER_WARNED', actionDesc]
    );

    res.json({ 
      success: true, 
      message: autoSuspended 
        ? `${targetName} has been warned and automatically suspended (reached ${newFlagsCount} moderation flags).`
        : `Warning sent successfully. Moderation flags: ${newFlagsCount}.`,
      moderation_flags: newFlagsCount,
      autoSuspended 
    });
  } catch (error) {
    console.error('Error warning user:', error);
    res.status(500).json({ error: 'Failed to warn user' });
  }
};

exports.suspendUser = async (req, res) => {
  try {
    const { id } = req.params;
    const { duration } = req.body;
    
    let suspendedUntil = null;
    if (duration === 'Short Temporary (3-7 days)') {
      suspendedUntil = new Date();
      suspendedUntil.setDate(suspendedUntil.getDate() + 7);
    } else if (duration === 'Long Temporary (30 days)') {
      suspendedUntil = new Date();
      suspendedUntil.setDate(suspendedUntil.getDate() + 30);
    }

    const result = await pool.query(
      'UPDATE users SET is_suspended = true, suspended_until = $2, suspension_count = COALESCE(suspension_count, 0) + 1 WHERE user_id = $1 RETURNING full_name', 
      [id, suspendedUntil]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const targetName = result.rows[0].full_name || 'user';
    const adminId = req.user.userId;
    const suspensionDuration = duration || 'Indefinite';

    await pool.query(
      'INSERT INTO admin_audit_logs (user_id, action_type, description) VALUES ($1, $2, $3)',
      [adminId, 'USER_SUSPENDED', `Manually suspended ${targetName}. Duration: ${suspensionDuration}.`]
    );

    // Notify Main API to kill active sessions and blacklist token
    await redis.publish('admin:users', JSON.stringify({ action: 'suspended', userId: id }));
    
    // Set TTL based on duration
    let ttlSeconds = 7 * 24 * 60 * 60; // default 7 days
    if (duration === 'Long Temporary (30 days)') ttlSeconds = 30 * 24 * 60 * 60;
    else if (duration === 'Indefinite' || !duration) ttlSeconds = 365 * 24 * 60 * 60; // 1 year
    
    await redis.setex(`suspended_user:${id}`, ttlSeconds, 'true');

    res.json({ success: true, message: 'User suspended successfully' });
  } catch (error) {
    console.error('Error suspending user:', error);
    res.status(500).json({ error: 'Failed to suspend user' });
  }
};

exports.unsuspendUser = async (req, res) => {
  try {
    const { id } = req.params;
    const updateQuery = `UPDATE users SET is_suspended = false, suspended_until = NULL, moderation_flags = 0 WHERE user_id = $1 RETURNING full_name`;
    const result = await pool.query(updateQuery, [id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    const targetName = result.rows[0].full_name || 'user';
    const adminId = req.user.userId;

    await pool.query(
      'INSERT INTO admin_audit_logs (user_id, action_type, description) VALUES ($1, $2, $3)',
      [adminId, 'USER_UNSUSPENDED', `Manually reinstated access for ${targetName}.`]
    );

    // Remove suspension from Redis
    await redis.del(`suspended_user:${id}`);

    res.json({ success: true, message: 'User unsuspended and flags reset to 0' });
  } catch (error) {
    console.error('Error unsuspending user:', error);
    res.status(500).json({ error: 'Failed to unsuspend user' });
  }
};

exports.bulkWarnUsers = async (req, res) => {
  try {
    const { userIds, reason, message, isSevere } = req.body;
    if (!Array.isArray(userIds) || userIds.length === 0) {
      return res.status(400).json({ error: 'No user IDs provided' });
    }

    const adminId = req.user.userId;
    const points = isSevere ? 1 : 0;
    const results = [];

    for (const id of userIds) {
      // 1. Insert warning
      await pool.query(
        'INSERT INTO user_warnings (user_id, reason, message, is_severe) VALUES ($1, $2, $3, $4)',
        [id, reason, message, isSevere]
      );

      // 2. Increment flags
      const updateResult = await pool.query(
        'UPDATE users SET moderation_flags = COALESCE(moderation_flags, 0) + $2 WHERE user_id = $1 RETURNING moderation_flags, full_name',
        [id, points]
      );

      if (updateResult.rows.length === 0) {
        results.push({ id, status: 'Not Found' });
        continue;
      }

      const newFlagsCount = parseInt(updateResult.rows[0].moderation_flags);
      const targetName = updateResult.rows[0].full_name || 'user';
      let autoSuspended = false;

      // 3. Auto-suspension check
      if (newFlagsCount >= 7) {
        await pool.query(
          'UPDATE users SET is_suspended = true, suspension_count = COALESCE(suspension_count, 0) + 1, moderation_flags = 0 WHERE user_id = $1',
          [id]
        );
        autoSuspended = true;
        await pool.query(
          'INSERT INTO admin_audit_logs (user_id, action_type, description) VALUES ($1, $2, $3)',
          [adminId, 'USER_SUSPENDED', `Automatically suspended ${targetName} due to exceeding 7 moderation flags.`]
        );
        
        // Notify Main API to kill active sessions and blacklist token
        await redis.publish('admin:users', JSON.stringify({ action: 'suspended', userId: id }));
        await redis.setex(`suspended_user:${id}`, 7 * 24 * 60 * 60, 'true'); // 7 days TTL
      }

      // 4. Log warning
      const actionDesc = isSevere 
        ? `Issued a SEVERE warning to ${targetName} for: ${reason}`
        : `Issued a warning to ${targetName} for: ${reason}`;
      await pool.query(
        'INSERT INTO admin_audit_logs (user_id, action_type, description) VALUES ($1, $2, $3)',
        [adminId, 'USER_WARNED', actionDesc]
      );

      results.push({ id, name: targetName, moderation_flags: newFlagsCount, autoSuspended });
    }

    res.json({ success: true, results });
  } catch (error) {
    console.error('Error warning users in bulk:', error);
    res.status(500).json({ error: 'Failed to warn users in bulk' });
  }
};

exports.bulkSuspendUsers = async (req, res) => {
  try {
    const { userIds } = req.body;
    if (!Array.isArray(userIds) || userIds.length === 0) {
      return res.status(400).json({ error: 'No user IDs provided' });
    }

    const adminId = req.user.userId;
    const results = [];

    for (const id of userIds) {
      const updateResult = await pool.query(
        'UPDATE users SET is_suspended = true, suspension_count = COALESCE(suspension_count, 0) + 1 WHERE user_id = $1 RETURNING full_name',
        [id]
      );

      if (updateResult.rows.length === 0) {
        results.push({ id, status: 'Not Found' });
        continue;
      }

      const targetName = updateResult.rows[0].full_name || 'user';
      await pool.query(
        'INSERT INTO admin_audit_logs (user_id, action_type, description) VALUES ($1, $2, $3)',
        [adminId, 'USER_SUSPENDED', `Manually suspended ${targetName} (Bulk Action).`]
      );

      // Notify Main API to kill active sessions and blacklist token
      await redis.publish('admin:users', JSON.stringify({ action: 'suspended', userId: id }));
      await redis.setex(`suspended_user:${id}`, 365 * 24 * 60 * 60, 'true'); // 1 year TTL for bulk

      results.push({ id, name: targetName, status: 'Suspended' });
    }

    res.json({ success: true, results });
  } catch (error) {
    console.error('Error suspending users in bulk:', error);
    res.status(500).json({ error: 'Failed to suspend users in bulk' });
  }
};

exports.updateUser = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, phone, role, location } = req.body;
    const adminId = req.user.userId;

    // Build dynamic query
    let queryArgs = [];
    let setStrings = [];
    let argCount = 1;

    if (name !== undefined) {
      setStrings.push(`full_name = $${argCount++}`);
      queryArgs.push(name);
    }
    if (phone !== undefined) {
      setStrings.push(`mobile_number = $${argCount++}`);
      queryArgs.push(phone);
    }
    if (role !== undefined) {
      setStrings.push(`user_type = $${argCount++}`);
      queryArgs.push(role);
    }
    if (location !== undefined) {
      setStrings.push(`location_formatted = $${argCount++}`);
      queryArgs.push(location);
    }

    if (setStrings.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    queryArgs.push(id);
    const updateQuery = `UPDATE users SET ${setStrings.join(', ')} WHERE user_id = $${argCount} RETURNING full_name, user_type`;
    
    const result = await pool.query(updateQuery, queryArgs);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    await pool.query(
      'INSERT INTO admin_audit_logs (user_id, action_type, description) VALUES ($1, $2, $3)',
      [adminId, 'USER_UPDATED', `Updated profile data for ${result.rows[0].full_name}`]
    );

    res.json({ success: true, message: 'User updated successfully' });
  } catch (error) {
    console.error('Error updating user:', error);
    res.status(500).json({ error: 'Failed to update user' });
  }
};

exports.deleteUser = async (req, res) => {
  try {
    const { id } = req.params;
    const adminId = req.user.userId;

    const result = await pool.query(
      'UPDATE users SET is_deleted = true WHERE user_id = $1 RETURNING full_name',
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    await pool.query(
      'INSERT INTO admin_audit_logs (user_id, action_type, description) VALUES ($1, $2, $3)',
      [adminId, 'USER_DELETED', `Soft deleted user ${result.rows[0].full_name}`]
    );

    res.json({ success: true, message: 'User deleted successfully' });
  } catch (error) {
    console.error('Error deleting user:', error);
    res.status(500).json({ error: 'Failed to delete user' });
  }
};

