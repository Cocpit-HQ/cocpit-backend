const pool = require('../../../core/db/pool');
const { logAdminActivity } = require('../../utils/auditLogger');

exports.getJobs = async (req, res) => {
  try {
    const { moderation_status = 'UNDER_REVIEW', page = 1, limit = 10, search = '' } = req.query;
    const offset = (page - 1) * limit;

    let queryParams = [moderation_status];
    let whereClause = `WHERE moderation_status = $1`;

    if (search.trim()) {
      queryParams.push(`%${search.trim()}%`);
      const searchIndex = queryParams.length;
      whereClause += ` AND (title ILIKE $${searchIndex} OR company_name ILIKE $${searchIndex} OR location ILIKE $${searchIndex})`;
    }

    // Get total count for pagination
    const countQuery = `SELECT COUNT(*) FROM jobs ${whereClause}`;
    const countResult = await req.db.query(countQuery, queryParams);
    const total = parseInt(countResult.rows[0].count, 10);

    // Get paginated jobs
    const dataQuery = `
      SELECT 
        jobs.job_id,
        jobs.recruiter_id,
        jobs.title,
        jobs.company_name,
        jobs.location,
        jobs.description,
        jobs.work_mode,
        jobs.company_type,
        jobs.experience_level,
        jobs.match_score,
        jobs.is_active,
        jobs.created_at,
        jobs.is_offer,
        jobs.job_type,
        jobs.about_company,
        jobs.easy_apply,
        jobs.actively_hiring,
        jobs.industry,
        jobs.salary_min,
        jobs.salary_max,
        jobs.org_id,
        jobs.posted_as_company,
        jobs.status,
        jobs.expires_at,
        jobs.salary_currency,
        jobs.salary_period,
        jobs.salary_visibility,
        jobs.jd_text,
        jobs.jd_raw_url,
        jobs.experience_min,
        jobs.experience_max,
        jobs.experience_label,
        jobs.ai_extracted_requirements,
        jobs.moderation_status,
        jobs.rejection_reason,
        jobs.published_at,
        jobs.created_at,
        jobs.updated_at,
        u.full_name AS recruiter_name,
        u.email AS recruiter_email,
        o.name AS organization_name
      FROM jobs
      LEFT JOIN users u ON jobs.recruiter_id = u.user_id
      LEFT JOIN organizations o ON jobs.org_id = o.org_id
      ${whereClause}
      ORDER BY COALESCE(jobs.published_at, jobs.created_at) DESC
      LIMIT $${queryParams.length + 1} OFFSET $${queryParams.length + 2}
    `;

    const result = await req.db.query(dataQuery, [...queryParams, limit, offset]);

    res.json({
      jobs: result.rows,
      total,
      page: parseInt(page, 10),
      totalPages: Math.ceil(total / limit) || 1
    });
  } catch (err) {
    require('fs').writeFileSync('error.log', err.stack);
    console.error('Error fetching jobs:', err);
    res.status(500).json({ error: 'Server error fetching jobs' });
  }
};

exports.moderateJob = async (req, res) => {
  try {
    const { id } = req.params;
    const { action, rejection_reason = null } = req.body; // 'approve' or 'reject'

    if (!action || !['approve', 'reject'].includes(action)) {
      return res.status(400).json({ error: 'Invalid moderation action. Must be approve or reject.' });
    }

    let statusVal = '';
    let modStatusVal = '';
    let logAction = '';

    if (action === 'approve') {
      statusVal = 'ACTIVE';
      modStatusVal = 'APPROVED';
      logAction = 'APPROVE_JOB';
    } else {
      statusVal = 'CLOSED';
      modStatusVal = 'REJECTED';
      logAction = 'REJECT_JOB';
    }

    const query = `
      UPDATE jobs 
      SET status = $1, moderation_status = $2, is_active = $3, rejection_reason = $5,
          published_at = CASE WHEN $1 = 'ACTIVE' AND published_at IS NULL THEN NOW() ELSE published_at END,
          created_at = CASE WHEN $1 = 'ACTIVE' AND (status = 'DRAFT' OR status = 'UNDER_REVIEW') THEN NOW() ELSE created_at END
      WHERE job_id = $4
      RETURNING *
    `;
    const isActive = (modStatusVal === 'APPROVED');
    const result = await req.db.query(query, [statusVal, modStatusVal, isActive, id, rejection_reason]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Job not found' });
    }

    const job = result.rows[0];

    // Log the audit activity
    await logAdminActivity(req.db, 
      req.user.userId,
      logAction,
      `Moderated job "${job.title}" by "${job.company_name}": status set to ${modStatusVal}`
    );

    // Send notifications to job recruiter/owner
    if (job.recruiter_id) {
      try {
        const isApproved = modStatusVal === 'APPROVED';
        const notifType = isApproved ? 'job_approved' : 'job_rejected';
        const notifText = isApproved
          ? `Your job ${job.title} is now live.`
          : `Your job ${job.title} wasn’t approved. Reason: ${rejection_reason || 'Not specified'}.`;

        const metadataPayload = {
          jobId: job.job_id,
          job_id: job.job_id,
          jobTitle: job.title,
          companyName: job.company_name,
          orgId: job.org_id,
          org_id: job.org_id,
          status: modStatusVal,
          rejectionReason: rejection_reason
        };

        const notifRes = await req.db.query(
          `INSERT INTO notifications (user_id, sender_id, type, text, reference_id, metadata)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING notification_id, created_at`,
          [job.recruiter_id, req.user.userId, notifType, notifText, job.job_id, JSON.stringify(metadataPayload)]
        );

        const socketService = require('../../../core/infrastructure/socket.service');
        if (socketService && typeof socketService.notifyUser === 'function') {
          socketService.notifyUser(job.recruiter_id, "notification", {
            notification_id: notifRes.rows[0]?.notification_id,
            type: notifType,
            text: notifText,
            sender_id: req.user.userId,
            reference_id: job.job_id,
            metadata: metadataPayload,
            created_at: notifRes.rows[0]?.created_at || new Date().toISOString(),
            is_read: false
          });
        }
      } catch (notifErr) {
        console.error("Failed to dispatch job moderation notification:", notifErr);
      }
    }

    res.json({
      message: `Job successfully ${modStatusVal.toLowerCase()}`,
      job
    });
  } catch (err) {
    console.error('Error moderating job:', err);
    res.status(500).json({ error: 'Server error moderating job' });
  }
};

exports.getJobById = async (req, res) => {
  try {
    const { id } = req.params;
    const query = `
      SELECT 
        jobs.job_id,
        jobs.recruiter_id,
        jobs.title,
        jobs.company_name,
        jobs.location,
        jobs.description,
        jobs.work_mode,
        jobs.company_type,
        jobs.experience_level,
        jobs.match_score,
        jobs.is_active,
        jobs.created_at,
        jobs.is_offer,
        jobs.job_type,
        jobs.about_company,
        jobs.easy_apply,
        jobs.actively_hiring,
        jobs.industry,
        jobs.salary_min,
        jobs.salary_max,
        jobs.org_id,
        jobs.posted_as_company,
        jobs.status,
        jobs.expires_at,
        jobs.salary_currency,
        jobs.salary_period,
        jobs.salary_visibility,
        jobs.jd_text,
        jobs.jd_raw_url,
        jobs.experience_min,
        jobs.experience_max,
        jobs.experience_label,
        jobs.ai_extracted_requirements,
        jobs.moderation_status,
        jobs.rejection_reason,
        u.full_name AS recruiter_name,
        u.email AS recruiter_email,
        o.name AS organization_name
      FROM jobs
      LEFT JOIN users u ON jobs.recruiter_id = u.user_id
      LEFT JOIN organizations o ON jobs.org_id = o.org_id
      WHERE jobs.job_id = $1
    `;
    const result = await req.db.query(query, [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Job not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error fetching job details by ID:', err);
    res.status(500).json({ error: 'Server error fetching job details' });
  }
};

