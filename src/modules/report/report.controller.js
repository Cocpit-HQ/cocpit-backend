const pool = require("../../core/db/pool");

/**
 * Get active report reasons
 */
exports.getReportReasons = async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, code, label FROM report_reasons WHERE active = TRUE ORDER BY id ASC"
    );
    res.json(result.rows);
  } catch (err) {
    console.error("Get report reasons error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
};

/**
 * Create a new report
 */
exports.createReport = async (req, res) => {
  const reporterId = req.user?.sub;
  const { targetType, targetId, reasonId, customReason } = req.body;

  // 1. Basic Validation
  if (!targetType || !targetId) {
    return res.status(400).json({ message: "targetType and targetId are required" });
  }

  if (!reasonId && !customReason) {
    return res.status(400).json({ message: "Provide either a reasonId or a customReason" });
  }

  const validTypes = ["POST", "USER", "COMMENT", "COMPANY"];
  if (!validTypes.includes(targetType)) {
    return res.status(400).json({ message: `Invalid targetType: ${targetType}` });
  }

  try {
    // 2. Validate Target Existence & Ownership
    let authorId = null;
    let exists = false;
    let query = "";
    
    switch (targetType) {
      case "POST":
        query = "SELECT author_id FROM posts WHERE post_id = $1";
        break;
      case "USER":
        // For users, the targetId IS the authorId
        query = "SELECT user_id FROM users WHERE user_id = $1";
        break;
      case "COMMENT":
        query = "SELECT author_id FROM post_comments WHERE comment_id = $1";
        break;
      case "COMPANY":
        // For companies, check if reporter is an OWNER/ADMIN
        query = `
          SELECT 1 FROM organizations o 
          LEFT JOIN organization_members om ON o.org_id = om.org_id AND om.user_id = $2
          WHERE o.org_id = $1 AND (om.role IN ('OWNER', 'ADMIN') OR om.role IS NULL)
        `;
        break;
    }
    
    if (query) {
      const queryParams = [targetId];
      if (targetType === "COMPANY") queryParams.push(reporterId);
      
      const targetRes = await pool.query(query, queryParams);
      exists = targetRes.rowCount > 0;
      
      if (exists) {
        if (targetType === "COMPANY") {
          // Special logic for company: If the query returned a row but the reporter has a role, block it.
          // Wait, actually, let's just fetch the owner/role specifically.
          const checkRole = await pool.query(
            "SELECT role FROM organization_members WHERE org_id = $1 AND user_id = $2",
            [targetId, reporterId]
          );
          if (checkRole.rowCount > 0 && ['OWNER', 'ADMIN'].includes(checkRole.rows[0].role)) {
            return res.status(400).json({ message: "Owners and Admins cannot report their own organization" });
          }
        } else {
          authorId = targetRes.rows[0].author_id || targetRes.rows[0].user_id;
          if (authorId === reporterId) {
            return res.status(400).json({ message: `You cannot report your own ${targetType.toLowerCase()}` });
          }
        }
      }
    }

    if (!exists) {
      return res.status(404).json({ message: `${targetType} not found` });
    }

    // 3. Duplicate Prevention (Checked via DB Unique Constraint, but can also check here)
    const duplicateRes = await pool.query(
      "SELECT 1 FROM reports WHERE reporter_id = $1 AND target_type = $2 AND target_id = $3",
      [reporterId, targetType, targetId]
    );

    if (duplicateRes.rowCount > 0) {
      return res.status(409).json({ message: "You have already reported this content" });
    }

    // 4. Save Report
    await pool.query(
      `INSERT INTO reports (reporter_id, target_type, target_id, reason_id, custom_reason)
       VALUES ($1, $2, $3, $4, $5)`,
      [reporterId, targetType, targetId, reasonId || null, customReason || null]
    );

    res.status(201).json({ message: "Report submitted successfully" });

  } catch (err) {
    // Handle unique constraint manually just in case
    if (err.code === "23505") {
      return res.status(409).json({ message: "You have already reported this content" });
    }
    console.error("Create report error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
};
