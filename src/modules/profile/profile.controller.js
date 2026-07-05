const { incrementUserHashtagScore } = require("../../services/recommendation.service");
const { z } = require("zod");
/**
 * Profile Controller (Thin)
 * Parses request, calls repository, sends response. No SQL. Minimal business logic.
 */
const profileRepo = require("./profile.repository");
const { checkBlockStatus } = require("../../core/utils/blockCheck");
const pool = require("../../core/db/pool");
const { handleExperienceOrgLink, handleEducationOrgLink, cleanupPreviousCompanyMemberships } = require("../../utils/orgLinkHelper");

// ─── Experience Validation Helpers ──────────────────────────────────────────────

/**
 * Returns true if two date ranges overlap.
 * A null end date means "currently active" — treated as the far future.
 */
const FAR_FUTURE = new Date('9999-12-31');
const datesOverlap = (aStart, aEnd, bStart, bEnd) => {
    const a1 = new Date(aStart);
    const a2 = aEnd ? new Date(aEnd) : FAR_FUTURE;
    const b1 = new Date(bStart);
    const b2 = bEnd ? new Date(bEnd) : FAR_FUTURE;
    return a1 < b2 && b1 < a2;
};

/**
 * Determines the severity of adding a new is_current role when others already exist.
 * Uses a work_type × work_mode matrix to decide:
 *   'block'  — Full-time On-site + Full-time On-site (physically impossible)
 *   'warn'   — Unusual but plausible (e.g. two full-time roles, >3 simultaneous)
 *   'allow'  — Normal (freelance, contract, part-time, remote combinations)
 */
const getMultipleCurrentSeverity = (activeRoles, newWorkType, newWorkMode) => {
    if (!activeRoles || activeRoles.length === 0) return 'allow';

    const norm = (s) => (s || '').toLowerCase().replace(/-/g, ' ').trim();
    const newType = norm(newWorkType);
    const newMode = norm(newWorkMode);

    // >3 simultaneous present roles — always warn regardless of type
    if (activeRoles.length >= 3) return 'warn';

    for (const e of activeRoles) {
        const eType = norm(e.work_type);
        const eMode = norm(e.work_mode);

        const newIsFullTime = newType === 'full time';
        const eIsFullTime   = eType  === 'full time';
        const newIsOnsite   = newMode === 'on site' || newMode === 'onsite';
        const eIsOnsite     = eMode  === 'on site'  || eMode  === 'onsite';

        // ── BLOCK ───────────────────────────────────────────────────────────────
        // Two full-time on-site roles simultaneously is physically impossible.
        if (newIsFullTime && newIsOnsite && eIsFullTime && eIsOnsite) return 'block';

        // ── ALLOW ───────────────────────────────────────────────────────────────
        // Freelance, Contract, Part-time, Internship can coexist with anything.
        const flexTypes = ['freelance', 'contract', 'part time', 'internship'];
        if (flexTypes.includes(newType) || flexTypes.includes(eType)) continue;

        // Two remote roles of any type — no physical constraint.
        if (newMode === 'remote' && eMode === 'remote') continue;

        // ── WARN ────────────────────────────────────────────────────────────────
        // Everything else that isn't obviously fine (e.g. two full-time roles).
        return 'warn';
    }

    return 'allow';
};

/**
 * Builds the human-readable conflict message for warn / block responses.
 */
const describeConflict = (activeRoles, newWorkType, newWorkMode, severity) => {
    const first = activeRoles[0];
    const count = activeRoles.length;
    if (severity === 'block') {
        return `You already have a full-time on-site role ("${first.title}" at "${first.company_name}"). Two simultaneous full-time on-site positions are not possible — please end the existing role first.`;
    }
    if (count >= 3) {
        return `You currently have ${count} active roles marked as present. This is unusual — please make sure all are intentional.`;
    }
    return `You already have an active role ("${first.title}" at "${first.company_name}"). Adding another current role is allowed for freelance / remote work, but make sure this is intentional.`;
};

// ─── Get Profile ────────────────────────────────────────────────────────────────

exports.getProfile = async (req, res) => {
    let userId = req.params.id === "me" ? req.user.sub : req.params.id;
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    if (userId !== "me" && !uuidRegex.test(userId)) {
        try {
            const resolveResult = await pool.query(
                "SELECT user_id FROM users WHERE LOWER(account_name) = LOWER($1)",
                [userId]
            );
            if (resolveResult.rowCount === 0) {
                return res.status(404).json({ message: "User not found" });
            }
            userId = resolveResult.rows[0].user_id;
        } catch (err) {
            console.error("Username resolution error:", err);
            return res.status(500).json({ message: "Internal server error" });
        }
    }

    if (req.user && userId !== req.user.sub) {
        const isBlocked = await checkBlockStatus(req.user.sub, userId);
        if (isBlocked) return res.status(404).json({ message: "User not found" });
    }

    try {
        const u = await profileRepo.getFullProfile(userId);
        if (!u) return res.status(404).json({ message: "User not found" });

        const profileId = u.profile_id;
        userId = u.user_id;

        const [experiences, educations, skills, companyRoles, counts, resumeRow, userRole, interests] = await Promise.all([
            profileId ? profileRepo.getExperiences(profileId) : [],
            profileId ? profileRepo.getEducations(profileId) : [],
            profileId ? profileRepo.getSkills(profileId) : [],
            profileRepo.getCompanyRoles(userId),
            profileRepo.getSocialCounts(userId),
            profileRepo.getLatestResume(userId),
            profileRepo.getUserRole(userId),
            profileRepo.getUserInterests(userId),
        ]);

        const resume = resumeRow ? { originalName: resumeRow.file_name, url: resumeRow.file_url } : null;
        const latestEducation = educations[0] ? { 
            school: educations[0].school_name, 
            degree: educations[0].degree,
            school_logo: educations[0].school_logo || null
        } : null;

        let relationship = { isFollowing: false, isFollowedBy: false, connectionRequestStatus: null, connectionRequestId: null, connectionRequestSender: null };
        if (req.user && req.user.sub && req.user.sub !== u.user_id) {
            relationship = await profileRepo.getRelationshipInfo(req.user.sub, u.user_id);
        }

        res.json({
            user: {
                id: u.user_id, account_name: u.account_name, name: u.full_name, headline: u.headline, avatar: u.avatar_url,
                cover_image: u.cover_image_url, location: u.location, about: u.about_text, website: u.website,
                email: u.email, mobile_number: u.mobile_number, account_type: u.account_type,
                followers_count: parseInt(counts.followers_count), following_count: parseInt(counts.following_count),
                connections_count: parseInt(counts.connections_count),
                open_to: u.open_to, availability: u.availability, work_preference: u.work_preference,
                latest_education: latestEducation,
                is_following: relationship.isFollowing, is_followed_by: relationship.isFollowedBy,
                connection_request_status: relationship.connectionRequestStatus,
                connection_request_id: relationship.connectionRequestId,
                connection_request_sender: relationship.connectionRequestSender,
                created_at: u.created_at,
                version: u.version || 0,
                onboarding_step: u.onboarding_step || null,
                // Structured location fields (for onboarding state rehydration on refresh)
                location_formatted: u.location_formatted || null,
                location_country: u.location_country || null,
                location_state: u.location_state || null,
                location_city: u.location_city || null,
                location_lat: u.location_lat || null,
                location_lng: u.location_lng || null,
                location_place_id: u.location_place_id || null,
                // Role, skills, interests (for onboarding state rehydration on refresh)
                user_role: userRole || null,
                skill_names: skills.map(s => s.name),
                interest_names: interests.map(i => i.name),
            },
            experiences, educations, skills,
            organization_roles: companyRoles,
            resume,
        });
    } catch (err) {
        console.error("Get profile error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};

exports.getMyProfile = async (req, res) => {
    req.params.id = "me";
    return exports.getProfile(req, res);
};

// ─── Update Profile ─────────────────────────────────────────────────────────────

exports.updateProfile = async (req, res) => {
    const userId = req.user.sub;
    const { full_name, headline, job_title, company_name, school, degree, location, about_text, mobile_number,
        account_name, website } = req.body;

    if (full_name && full_name.trim().length < 3) return res.status(400).json({ message: "Full name must be at least 3 characters" });
    if (headline && headline.length > 120) return res.status(400).json({ message: "Headline cannot exceed 120 characters" });
    if (job_title && job_title.length > 80) return res.status(400).json({ message: "Job title cannot exceed 80 characters" });
    if (company_name && company_name.length > 80) return res.status(400).json({ message: "Company name cannot exceed 80 characters" });
    if (school && school.length > 100) return res.status(400).json({ message: "School cannot exceed 100 characters" });
    if (degree && degree.length > 100) return res.status(400).json({ message: "Degree cannot exceed 100 characters" });
    if (location && location.length > 150) return res.status(400).json({ message: "Location cannot exceed 150 characters" });
    if (about_text && about_text.length > 500) return res.status(400).json({ message: "About section cannot exceed 500 characters" });
    if (website && website.length > 255) return res.status(400).json({ message: "Website cannot exceed 255 characters" });
    // Validate account_name (username) if provided
    if (account_name !== undefined) {
        const usernameRegex = /^[a-zA-Z0-9_-]{3,30}$/;
        if (!usernameRegex.test(account_name)) {
            return res.status(400).json({ message: "Username must be 3-30 characters and contain only letters, numbers, underscores, or hyphens" });
        }

        // Check case-insensitive uniqueness
        const existing = await pool.query(
            "SELECT user_id FROM users WHERE LOWER(account_name) = LOWER($1) AND user_id != $2",
            [account_name, userId]
        );
        if (existing.rowCount > 0) {
            return res.status(409).json({ message: "Username is already taken" });
        }
    }

    try {
        await profileRepo.updateUserFields(userId, req.body);
        res.json({ message: "Profile updated successfully" });
    } catch (err) {
        console.error("Update profile error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};

// ─── Avatar ─────────────────────────────────────────────────────────────────────

exports.uploadOrReplaceAvatar = async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ message: "No file uploaded" });
        const avatarUrl = req.file.path || req.file.secure_url;
        await profileRepo.updateAvatarUrl(req.user.sub, avatarUrl);
        res.json({ message: "Profile picture updated successfully", avatarUrl });
    } catch (err) {
        console.error("Avatar upload error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};

exports.getAvatar = async (req, res) => {
    try {
        const avatarUrl = await profileRepo.getAvatarUrl(req.user.sub);
        if (!avatarUrl) return res.status(404).json({ message: "No profile picture found" });
        res.json({ avatarUrl });
    } catch (err) {
        console.error("Get avatar error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};

exports.deleteAvatar = async (req, res) => {
    try {
        await profileRepo.updateAvatarUrl(req.user.sub, null);
        res.json({ message: "Profile picture deleted successfully" });
    } catch (err) {
        console.error("Delete avatar error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};

// ─── Cover Photo ────────────────────────────────────────────────────────────────

exports.uploadOrReplaceCoverPhoto = async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ message: "No file uploaded" });
        const coverUrl = req.file.path || req.file.secure_url;
        await profileRepo.updateCoverUrl(req.user.sub, coverUrl);
        res.json({ message: "Cover photo updated successfully", coverUrl });
    } catch (err) {
        console.error("Cover upload error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};

exports.deleteCoverPhoto = async (req, res) => {
    try {
        await profileRepo.updateCoverUrl(req.user.sub, null);
        res.json({ message: "Cover photo deleted successfully" });
    } catch (err) {
        console.error("Delete cover error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};

// ─── Identity ───────────────────────────────────────────────────────────────────

exports.getIdentity = async (req, res) => {
    try {
        const identity = await profileRepo.getIdentity(req.user.sub);
        if (!identity) return res.status(404).json({ message: "Profile not found" });
        res.json(identity);
    } catch (err) {
        console.error("Get identity error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};


exports.updateIdentity = async (req, res) => {
    const { open_to, availability, work_preference, account_type } = req.body;
    const allowedOpenTo = ["Full-time", "Part-time", "Internship", "Freelance", "Connections"];
    const allowedAvailability = ["Immediately", "Weekdays", "Weekends", "15 to 30 days", "Flexible", "On-demand", "Immediate", "30 Days"];
    const allowedWorkPreference = ["Remote", "Hybrid", "On-site"];
    const allowedAccountTypes = ["student", "fresher", "intern", "self_employed", "employed", "unemployed", "Student", "Fresher", "Intern", "Self Employed", "Employee", "Employer", "Admin"];

    if (open_to && !allowedOpenTo.includes(open_to)) {
        return res.status(400).json({ message: "Invalid open_to value" });
    }
    if (availability && !allowedAvailability.includes(availability)) {
        return res.status(400).json({ message: "Invalid availability value" });
    }
    if (work_preference && !allowedWorkPreference.includes(work_preference)) {
        return res.status(400).json({ message: "Invalid work_preference value" });
    }
    if (account_type && !allowedAccountTypes.includes(account_type)) {
        return res.status(400).json({ message: "Invalid account type" });
    }

    try {
        const identity = await profileRepo.updateIdentity(req.user.sub, { 
            open_to: open_to || null, 
            availability: availability || null, 
            work_preference: work_preference || null, 
            account_type 
        });
        if (!identity) return res.status(404).json({ message: "Profile not found" });
        res.json({ message: "Professional identity updated successfully", identity });
    } catch (err) {
        console.error("Update identity error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};

// ─── Resume ─────────────────────────────────────────────────────────────────────

exports.uploadOrReplaceResume = async (req, res) => {
    if (!req.file) return res.status(400).json({ message: "Resume file is required" });
    try {
        const resume = await profileRepo.replaceResume(req.user.sub, req.file);
        res.status(201).json({ message: "Resume uploaded successfully", resume });
    } catch (err) {
        console.error("Upload/Replace resume error:", err);
        res.status(500).json({ message: "Failed to upload resume" });
    }
};

exports.getResume = async (req, res) => {
    try {
        const resume = await profileRepo.getResume(req.user.sub);
        if (!resume) return res.status(404).json({ message: "No resume found" });
        res.json(resume);
    } catch (err) {
        console.error("Get resume error:", err);
        res.status(500).json({ message: "Failed to fetch resume" });
    }
};

exports.deleteResume = async (req, res) => {
    try {
        const resume = await profileRepo.deleteResume(req.user.sub);
        if (!resume) return res.status(404).json({ message: "No resume found to delete" });
        res.json({ message: "Resume deleted successfully", resume });
    } catch (err) {
        console.error("Delete resume error:", err);
        res.status(500).json({ message: "Failed to delete resume" });
    }
};

// ─── Experiences ────────────────────────────────────────────────────────────────

exports.addExperience = async (req, res) => {
    const {
        title, company_name, location, work_type, work_mode,
        start_date, end_date, is_current, description, org_id,
        // ── Atomic end-role fields ────────────────────────────────────────────────
        end_current_role,    // boolean — end an existing active role in the same transaction
        end_current_role_id, // UUID    — which experience to end (required if flag is true)
        // end date of previous role = start_date of new role (same-day transition, no extra field)
    } = req.body;

    // ── Validate atomic end-role fields BEFORE touching the DB ───────────────────
    if (end_current_role && !end_current_role_id) {
        return res.status(422).json({
            message: "end_current_role_id is required when end_current_role is true",
            code: "END_ROLE_ID_MISSING",
        });
    }

    // ── Basic validation ──────────────────────────────────────────────────────────
    if (!start_date) {
        return res.status(422).json({ message: "Start date is required" });
    }
    if (!is_current && !end_date) {
        return res.status(422).json({ message: "End date is required when not currently working" });
    }
    if (end_date && new Date(end_date) < new Date(start_date)) {
        return res.status(422).json({ message: "End date must be on or after start date" });
    }

    const client = await pool.connect();
    try {
        const profileId = await profileRepo.ensureProfileId(req.user.sub);
        if (!profileId) return res.status(404).json({ message: "Profile not found" });

        // ── Cross-experience validation (runs before transaction opens) ───────────
        // The role being ended is excluded from all checks — it will be closed atomically.
        const allExperiences = await profileRepo.getExperiencesByProfileId(profileId);

        // ── Validate that the new start_date doesn't break the old role's date range ──
        if (end_current_role && end_current_role_id && start_date) {
            const roleToEnd = allExperiences.find(e => e.experience_id === end_current_role_id);
            if (roleToEnd && roleToEnd.start_date && new Date(start_date) < new Date(roleToEnd.start_date)) {
                return res.status(422).json({
                    message: "The new role's start date cannot be before the current role's start date.",
                    code: "END_ROLE_DATE_INVALID"
                });
            }
        }

        const companyNorm = (company_name || "").trim().toLowerCase();
        const newEnd = is_current ? null : end_date;

        // ── Same-company date overlap (hard block) ────────────────────────────────
        const sameCompany = allExperiences.filter(e => {
            if (!companyNorm) return false;
            if (end_current_role && e.experience_id === end_current_role_id) return false; // being ended
            return (org_id && e.org_id === org_id) ||
                   (!org_id && !e.org_id && (e.company_name || "").trim().toLowerCase() === companyNorm);
        });
        for (const e of sameCompany) {
            if (datesOverlap(start_date, newEnd, e.start_date, e.end_date)) {
                return res.status(422).json({
                    message: `Date range overlaps with your existing "${e.title}" role at "${e.company_name}". Adjust your dates or edit the existing record first.`,
                    code: 'DATE_OVERLAP',
                });
            }
        }

        // ── Multiple is_current check (work_type × work_mode matrix) ─────────────
        let warning = undefined;
        if (is_current) {
            const activeRoles = allExperiences.filter(e =>
                (e.is_current || !e.end_date) &&
                !(end_current_role && e.experience_id === end_current_role_id) // exclude role being ended
            );
            if (activeRoles.length > 0) {
                const severity = getMultipleCurrentSeverity(activeRoles, work_type, work_mode);
                if (severity === 'block') {
                    return res.status(422).json({
                        message: describeConflict(activeRoles, work_type, work_mode, severity),
                        code: 'MULTIPLE_CURRENT_BLOCKED',
                    });
                }
                if (severity === 'warn') {
                    warning = describeConflict(activeRoles, work_type, work_mode, severity);
                }
            }
        }

        // ── Atomic transaction: end old role + insert new role ────────────────────
        await client.query('BEGIN');

        // Step 1: End the existing role (only if requested)
        let endedExperience = null;
        if (end_current_role && end_current_role_id) {
            endedExperience = await profileRepo.endExperienceById(
                client, end_current_role_id, profileId,
                start_date // new role's start = previous role's end (same-day transition)
            );
            if (!endedExperience) {
                await client.query('ROLLBACK');
                return res.status(404).json({
                    message: "The experience to end was not found, not authorized, or is already ended",
                    code: "END_ROLE_NOT_FOUND",
                });
            }
        }

        // Step 2: Insert the new experience
        const expData = { title, company_name, location, work_type, work_mode, start_date, end_date, is_current, description, org_id };
        await handleExperienceOrgLink(client, req.user.sub, expData);

        const experience = await profileRepo.addExperienceInTx(
            client, profileId,
            expData
        );

        // Run previous company membership cleanup if applicable
        const prevOrgIds = [endedExperience?.org_id, expData.org_id];
        await cleanupPreviousCompanyMemberships(client, req.user.sub, prevOrgIds);

        await client.query('COMMIT');

        res.status(201).json({
            message: "Experience added successfully",
            experience,
            ...(endedExperience && { ended_experience: endedExperience }),
            ...(warning && { warning }),
        });
    } catch (err) {
        if (client) await client.query('ROLLBACK');
        console.error("Add experience error:", err);

        // Handle specific Postgres error codes
        if (err.code === '23505') { // Unique Violation
            return res.status(409).json({ 
                message: "Conflict detected: Multiple current roles at the same company or duplicate entry.",
                code: "UNIQUE_VIOLATION"
            });
        }
        if (err.code === '23514') { // Check Constraint Violation
            return res.status(422).json({ 
                message: "Data integrity violation: Ensure dates are valid and start date is before end date.",
                code: "CHECK_VIOLATION"
            });
        }

        res.status(500).json({ message: "Internal server error" });
    } finally {
        if (client) client.release();
    }
};

exports.updateExperience = async (req, res) => {
    const client = await pool.connect();
    try {
        const profileId = await profileRepo.getProfileId(req.user.sub);
        if (!profileId) return res.status(404).json({ message: "Profile not found" });
        const existing = await profileRepo.findExperience(req.params.id, profileId);
        if (!existing) return res.status(404).json({ message: "Experience not found or not authorized" });

        const { title, company_name, location, work_type, work_mode, start_date, end_date, is_current, description, org_id } = req.body;

        // ── Resolve effective values (merge patch with existing record) ────────────
        const resolvedStart   = start_date   !== undefined ? start_date   : existing.start_date;
        const resolvedEnd     = end_date     !== undefined ? end_date     : existing.end_date;
        const resolvedCurrent = is_current   !== undefined ? is_current   : existing.is_current;
        const resolvedCompany = company_name !== undefined ? company_name : existing.company_name;
        const resolvedOrgId   = org_id       !== undefined ? org_id       : existing.org_id;
        const resolvedWType   = work_type    !== undefined ? work_type    : existing.work_type;
        const resolvedWMode   = work_mode    !== undefined ? work_mode    : existing.work_mode;

        // ── Basic validation ──────────────────────────────────────────────────────
        if (!resolvedCurrent && !resolvedEnd) {
            return res.status(422).json({ message: "End date is required when not currently working" });
        }
        if (resolvedEnd && new Date(resolvedEnd) <= new Date(resolvedStart)) {
            return res.status(422).json({ message: "End date must be after start date" });
        }

        // Fetch all OTHER experiences (exclude self from all checks)
        const allExperiences = await profileRepo.getExperiencesByProfileId(profileId);
        const otherExperiences = allExperiences.filter(e => e.experience_id !== req.params.id);
        const companyNorm = (resolvedCompany || "").trim().toLowerCase();
        const resolvedNewEnd = resolvedCurrent ? null : resolvedEnd;

        // ── Same-company date overlap (hard block) ────────────────────────────────
        const sameCompanyOthers = otherExperiences.filter(e => {
            if (!companyNorm) return false;
            return (resolvedOrgId && e.org_id === resolvedOrgId) ||
                   (!resolvedOrgId && !e.org_id && (e.company_name || "").trim().toLowerCase() === companyNorm);
        });
        for (const e of sameCompanyOthers) {
            if (datesOverlap(resolvedStart, resolvedNewEnd, e.start_date, e.end_date)) {
                return res.status(422).json({
                    message: `Date range overlaps with your existing "${e.title}" role at "${e.company_name}". Adjust your dates or edit the existing record first.`,
                    code: 'DATE_OVERLAP',
                });
            }
        }

        // ── Multiple is_current check (work_type × work_mode matrix) ─────────────
        // Only run this check when transitioning a role from non-current → current.
        let warning = undefined;
        if (resolvedCurrent && !existing.is_current) {
            const activeRoles = otherExperiences.filter(e => e.is_current || !e.end_date);
            if (activeRoles.length > 0) {
                const severity = getMultipleCurrentSeverity(activeRoles, resolvedWType, resolvedWMode);
                if (severity === 'block') {
                    return res.status(422).json({
                        message: describeConflict(activeRoles, resolvedWType, resolvedWMode, severity),
                        code: 'MULTIPLE_CURRENT_BLOCKED',
                    });
                }
                if (severity === 'warn') {
                    warning = describeConflict(activeRoles, resolvedWType, resolvedWMode, severity);
                }
            }
        }
        // ─────────────────────────────────────────────────────────────────────────

        const resolvedTitle   = title        !== undefined ? title        : existing.title;
        const resolvedDesc    = description  !== undefined ? description  : existing.description;
        const resolvedLocation = location    !== undefined ? location     : existing.location;

        await client.query('BEGIN');

        const data = { 
            title: resolvedTitle, 
            company_name: resolvedCompany, 
            location: resolvedLocation, 
            work_type: resolvedWType, 
            work_mode: resolvedWMode, 
            start_date: resolvedStart, 
            end_date: resolvedEnd, 
            is_current: resolvedCurrent, 
            description: resolvedDesc, 
            org_id: resolvedOrgId 
        };
        await handleExperienceOrgLink(client, req.user.sub, data);

        const experience = await profileRepo.updateExperienceInTx(client, req.params.id, profileId, data);
        if (!experience) {
            await client.query('ROLLBACK');
            return res.status(400).json({ message: "No fields provided to update" });
        }

        // Clean up previous organization membership if applicable
        const prevOrgIds = [existing.org_id, experience.org_id];
        await cleanupPreviousCompanyMemberships(client, req.user.sub, prevOrgIds);

        await client.query('COMMIT');
        res.json({ message: "Experience updated successfully", experience, warning });
    } catch (err) {
        if (client) await client.query('ROLLBACK');
        console.error("Update experience error:", err);

        // Handle specific Postgres error codes
        if (err.code === '23505') { // Unique Violation
            return res.status(409).json({ 
                message: "Conflict detected: Multiple current roles at the same company or duplicate entry.",
                code: "UNIQUE_VIOLATION"
            });
        }
        if (err.code === '23514') { // Check Constraint Violation
            return res.status(422).json({ 
                message: "Data integrity violation: Ensure dates are valid and start date is before end date.",
                code: "CHECK_VIOLATION"
            });
        }

        res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
    }
};

exports.deleteExperience = async (req, res) => {
    const client = await pool.connect();
    try {
        const profileId = await profileRepo.getProfileId(req.user.sub);
        if (!profileId) return res.status(404).json({ message: "Profile not found" });

        await client.query('BEGIN');
        const deleted = await profileRepo.deleteExperienceInTx(client, req.params.id, profileId);
        if (!deleted) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: "Experience not found" });
        }

        if (deleted.org_id) {
            await cleanupPreviousCompanyMemberships(client, req.user.sub, [deleted.org_id]);
        }

        await client.query('COMMIT');
        res.json({ message: "Experience deleted successfully" });
    } catch (err) {
        if (client) await client.query('ROLLBACK');
        console.error("Delete experience error:", err);
        res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
    }
};

// ─── Educations ─────────────────────────────────────────────────────────────────

exports.addEducation = async (req, res) => {
    const client = await pool.connect();
    try {
        const profileId = await profileRepo.ensureProfileId(req.user.sub);
        if (!profileId) return res.status(404).json({ message: "Profile not found" });

        const { school_name, school_org_id, degree, field_of_study, location, start_date, end_date, description } = req.body;
        const data = { school_name, school_org_id, degree, field_of_study, location, start_date, end_date, description };

        await client.query('BEGIN');
        await handleEducationOrgLink(client, req.user.sub, data);

        const education = await profileRepo.addEducationInTx(client, profileId, data);

        await client.query('COMMIT');
        res.status(201).json({ message: "Education added successfully", education });
    } catch (err) {
        if (client) await client.query('ROLLBACK');
        console.error("Add education error:", err);
        res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
    }
};

exports.updateEducation = async (req, res) => {
    const client = await pool.connect();
    try {
        const profileId = await profileRepo.getProfileId(req.user.sub);
        if (!profileId) return res.status(404).json({ message: "Profile not found" });

        // Fetch existing record to resolve undefined fields in PATCH
        const existingRes = await client.query(
            `SELECT * FROM educations WHERE education_id = $1 AND profile_id = $2`,
            [req.params.id, profileId]
        );
        if (existingRes.rowCount === 0) return res.status(404).json({ message: "Education not found or not authorized" });
        const existing = existingRes.rows[0];

        const { school_name, school_org_id, degree, field_of_study, location, start_date, end_date, description } = req.body;

        const resolvedSchoolName = school_name !== undefined ? school_name : existing.school_name;
        const resolvedSchoolOrgId = school_org_id !== undefined ? school_org_id : existing.school_org_id;
        const resolvedDegree = degree !== undefined ? degree : existing.degree;
        const resolvedField = field_of_study !== undefined ? field_of_study : existing.field_of_study;
        const resolvedLocation = location !== undefined ? location : existing.location;
        const resolvedStart = start_date !== undefined ? start_date : existing.start_date;
        const resolvedEnd = end_date !== undefined ? end_date : existing.end_date;
        const resolvedDesc = description !== undefined ? description : existing.description;

        const data = {
            school_name: resolvedSchoolName,
            school_org_id: resolvedSchoolOrgId,
            degree: resolvedDegree,
            field_of_study: resolvedField,
            location: resolvedLocation,
            start_date: resolvedStart,
            end_date: resolvedEnd,
            description: resolvedDesc
        };

        await client.query('BEGIN');
        await handleEducationOrgLink(client, req.user.sub, data);

        const education = await profileRepo.updateEducationInTx(client, req.params.id, profileId, data);
        if (!education) {
            await client.query('ROLLBACK');
            return res.status(400).json({ message: "No fields provided to update" });
        }

        await client.query('COMMIT');
        res.json({ message: "Education updated successfully", education });
    } catch (err) {
        if (client) await client.query('ROLLBACK');
        console.error("Update education error:", err);
        res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
    }
};

exports.deleteEducation = async (req, res) => {
    try {
        const profileId = await profileRepo.getProfileId(req.user.sub);
        if (!profileId) return res.status(404).json({ message: "Profile not found" });
        const deleted = await profileRepo.deleteEducation(req.params.id, profileId);
        if (!deleted) return res.status(404).json({ message: "Education not found or not authorized to delete" });
        res.json({ message: "Education deleted successfully", education: deleted });
    } catch (err) {
        console.error("Delete education error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};

// ─── Skills ─────────────────────────────────────────────────────────────────────

exports.addSkills = async (req, res) => {
    const { name } = req.body;

    if (!Array.isArray(name) || name.length === 0) {
        return res.status(400).json({ message: "Name must be a non-empty array" });
    }

    const skillList = [...new Set(
        name.filter(s => typeof s === "string")
            .map(s => s.trim().toLowerCase().replace(/\s+/g, " ").split(" ").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" "))
            .filter(Boolean)
    )];

    if (!skillList.length) return res.status(400).json({ message: "No valid skills provided" });

    const client = await profileRepo.getClient();
    try {
        await client.query("BEGIN");

        const profileId = await profileRepo.ensureProfileId(req.user.sub);
        if (!profileId) throw new Error("PROFILE_NOT_FOUND");

        await client.query(`INSERT INTO skills (name) SELECT UNNEST($1::text[]) ON CONFLICT (lower(name)) DO NOTHING RETURNING skill_id, name`, [skillList]);

        const { rows: skills } = await client.query(
            `SELECT skill_id, name FROM skills WHERE lower(name) IN (SELECT lower(s) FROM UNNEST($1::text[]) AS s)`,
            [skillList]
        );

        if (skills.length > 0) {
            const values = skills.map((s, i) => `($1, $${i + 2})`).join(",");
            await client.query(
                `INSERT INTO user_skills (profile_id, skill_id) VALUES ${values} ON CONFLICT DO NOTHING`,
                [profileId, ...skills.map(s => s.skill_id)]
            );
        }

        await client.query("COMMIT");

        // Recommendation System Phase 1: Boost affinity safely out of transaction
        try {
            // We need to extract the skill names from what was just added
            // Let's assume req.body.skills is an array of objects or strings 
            // e.g. [{ skill_name: 'React' }] or ['React']
            let skillNames = [];
            if (Array.isArray(req.body?.skills)) {
                skillNames = req.body.skills.map(s => typeof s === 'string' ? s : s.skill_name || s.name).filter(Boolean);
            }
            if (skillNames.length > 0) {
                const userId = req.user.userId || req.user.id || req.user.sub || req.body.userId;
                incrementUserHashtagScore(userId, 5, skillNames, null).catch(() => { });
            }
        } catch (e) { }


        // Fetch ALL skills for this profile to return to frontend
        const allSkills = await profileRepo.getSkills(profileId);
        res.status(201).json({
            message: "Skills updated successfully",
            skills: allSkills
        });
    } catch (err) {
        await client.query("ROLLBACK");
        if (err.message === "PROFILE_NOT_FOUND") return res.status(404).json({ message: "Profile not found" });
        console.error("Add skills error:", err);
        res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
    }
};

exports.updateSkill = async (req, res) => {
    const skillId = req.params.id;
    const { name } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ message: "Skill name is required" });
    const newSkillName = name.trim();

    const client = await profileRepo.getClient();
    try {
        await client.query("BEGIN");

        const profileResult = await client.query(`SELECT profile_id FROM profiles WHERE user_id = $1`, [req.user.sub]);
        if (profileResult.rowCount === 0) { await client.query("ROLLBACK"); return res.status(404).json({ message: "Profile not found" }); }
        const profileId = profileResult.rows[0].profile_id;

        const userSkillCheck = await client.query(`SELECT * FROM user_skills WHERE profile_id = $1 AND skill_id = $2`, [profileId, skillId]);
        if (userSkillCheck.rowCount === 0) { await client.query("ROLLBACK"); return res.status(404).json({ message: "Skill not found or not authorized to update" }); }

        const skillExists = await client.query(`SELECT skill_id, name FROM skills WHERE LOWER(name) = LOWER($1)`, [newSkillName]);
        let finalSkillId, finalSkillName;

        if (skillExists.rowCount > 0) {
            finalSkillId = skillExists.rows[0].skill_id;
            finalSkillName = skillExists.rows[0].name;
            await client.query(`UPDATE user_skills SET skill_id = $1 WHERE profile_id = $2 AND skill_id = $3`, [finalSkillId, profileId, skillId]);
        } else {
            const newSkill = await client.query(`INSERT INTO skills (name) VALUES ($1) RETURNING skill_id, name`, [newSkillName]);
            finalSkillId = newSkill.rows[0].skill_id;
            finalSkillName = newSkill.rows[0].name;
            await client.query(`UPDATE user_skills SET skill_id = $1 WHERE profile_id = $2 AND skill_id = $3`, [finalSkillId, profileId, skillId]);
        }

        await client.query("COMMIT");
        res.json({ message: "Skill updated successfully", skill: { skill_id: finalSkillId, name: finalSkillName } });
    } catch (err) {
        await client.query("ROLLBACK");
        console.error("Update skill error:", err);
        res.status(500).json({ message: "Internal server error" });
    } finally {
        client.release();
    }
};

exports.deleteSkill = async (req, res) => {
    try {
        const profileId = await profileRepo.getProfileId(req.user.sub);
        if (!profileId) return res.status(404).json({ message: "Profile not found" });
        const deleted = await profileRepo.deleteSkillMapping(profileId, req.params.id);
        if (!deleted) return res.status(404).json({ message: "Skill not found or not authorized to delete" });
        res.json({ message: "Skill removed successfully", skillId: req.params.id });
    } catch (err) {
        console.error("Delete skill error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};

// ─── Reference Data (Interests & Skills) ─────────────────────────────────────────

exports.getInterests = async (req, res) => {
    try {
        const { page = 1, search = "" } = req.query;
        const pageNumber = parseInt(page, 10) || 1;
        const limit = 10;
        const offset = (pageNumber - 1) * limit;

        let query = "SELECT interest_id AS id, name FROM interests WHERE is_active = true";
        const params = [];

        if (search) {
            params.push(`%${search}%`);
            query += ` AND name ILIKE $${params.length}`;
        }

        query += ` ORDER BY name ASC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
        params.push(limit, offset);

        const result = await pool.query(query, params);

        res.json(result.rows);
    } catch (err) {
        console.error("Get interests error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};

exports.getSkills = async (req, res) => {
    const { q = "", cursor: rawCursor = "", limit: rawLimit = "20" } = req.query;

    const limit = Math.min(50, Math.max(1, parseInt(rawLimit, 10) || 20));
    const searchPattern = q.trim() ? `%${q.trim()}%` : null;

    // Decode cursor — base64(name of last seen item)
    let cursorName = null;
    if (rawCursor) {
        try {
            cursorName = Buffer.from(rawCursor, "base64").toString("utf8");
        } catch (_) {
            return res.status(400).json({ success: false, message: "Invalid cursor" });
        }
    }

    try {
        // Fetch limit+1 rows so we can detect if there's a next page
        const dataRes = await pool.query(
            `SELECT skill_id, name
             FROM skills
             WHERE is_active = TRUE
               AND ($1::text IS NULL OR name ILIKE $1)
               AND ($2::text IS NULL OR LOWER(name) > LOWER($2))
               AND name !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
             ORDER BY LOWER(name) ASC
             LIMIT $3`,
            [searchPattern, cursorName, limit + 1]
        );

        const rows = dataRes.rows;
        const has_more = rows.length > limit;
        const items = has_more ? rows.slice(0, limit) : rows;

        // Encode cursor from last returned item's name
        const next_cursor = has_more
            ? Buffer.from(items[items.length - 1].name, "utf8").toString("base64")
            : null;

        return res.status(200).json({
            success: true,
            data: {
                items,
                next_cursor,
                has_more
            }
        });
    } catch (err) {
        console.error("Get skills error:", err);
        return res.status(500).json({ success: false, message: "Internal server error" });
    }
};

exports.getEducationList = async (req, res) => {
    try {
        const { school_search = "", degree_search = "", specialization_search = "" } = req.query;

        // 🎯 School query — UNION school names from educations and organizations table (type: INSTITUTION), de-duplicating case-insensitively
        let schoolQuery, schoolParams;
        if (school_search) {
            schoolParams = [`%${school_search}%`];
            schoolQuery = `
                WITH combined AS (
                    SELECT school_name
                    FROM educations
                    WHERE school_name IS NOT NULL AND school_name != ''
                      AND LOWER(school_name) LIKE LOWER($1)
                    UNION
                    SELECT name AS school_name
                    FROM organizations
                    WHERE name IS NOT NULL AND name != ''
                      AND entity_type = 'INSTITUTION'
                      AND is_deleted = FALSE
                      AND LOWER(name) LIKE LOWER($1)
                )
                SELECT DISTINCT ON (LOWER(TRIM(school_name))) school_name
                FROM combined
                ORDER BY LOWER(TRIM(school_name))
                LIMIT 50`;
        } else {
            schoolParams = [];
            schoolQuery = `
                WITH combined AS (
                    SELECT school_name
                    FROM educations
                    WHERE school_name IS NOT NULL AND school_name != ''
                    UNION
                    SELECT name AS school_name
                    FROM organizations
                    WHERE name IS NOT NULL AND name != ''
                      AND entity_type = 'INSTITUTION'
                      AND is_deleted = FALSE
                )
                SELECT DISTINCT ON (LOWER(TRIM(school_name))) school_name
                FROM combined
                ORDER BY LOWER(TRIM(school_name))
                LIMIT 50`;
        }

        // 🎯 Degree query — case-insensitive DISTINCT via DISTINCT ON
        let degreeQuery, degreeParams;
        if (degree_search) {
            degreeParams = [`%${degree_search}%`];
            degreeQuery = `
                SELECT DISTINCT ON (LOWER(TRIM(degree))) degree
                FROM educations
                WHERE degree IS NOT NULL AND degree != ''
                  AND LOWER(degree) LIKE LOWER($1)
                ORDER BY LOWER(TRIM(degree))
                LIMIT 50`;
        } else {
            degreeParams = [];
            degreeQuery = `
                SELECT DISTINCT ON (LOWER(TRIM(degree))) degree
                FROM educations
                WHERE degree IS NOT NULL AND degree != ''
                ORDER BY LOWER(TRIM(degree))
                LIMIT 50`;
        }

        // 🎯 Specialization query — always runs, filter if param provided
        let specializationQuery, specializationParams;
        if (specialization_search) {
            specializationParams = [`%${specialization_search}%`];
            specializationQuery = `
                SELECT DISTINCT ON (LOWER(TRIM(field_of_study))) field_of_study
                FROM educations
                WHERE field_of_study IS NOT NULL AND field_of_study != ''
                  AND LOWER(field_of_study) LIKE LOWER($1)
                ORDER BY LOWER(TRIM(field_of_study))
                LIMIT 50`;
        } else {
            specializationParams = [];
            specializationQuery = `
                SELECT DISTINCT ON (LOWER(TRIM(field_of_study))) field_of_study
                FROM educations
                WHERE field_of_study IS NOT NULL AND field_of_study != ''
                ORDER BY LOWER(TRIM(field_of_study))
                LIMIT 50`;
        }

        // 🔥 Run all three queries in parallel
        const [schoolResult, degreeResult, specializationResult] = await Promise.all([
            pool.query(schoolQuery, schoolParams),
            pool.query(degreeQuery, degreeParams),
            pool.query(specializationQuery, specializationParams),
        ]);

        return res.json({
            degrees: degreeResult.rows.map(r => r.degree),
            school_names: schoolResult.rows.map(r => r.school_name),
            specializations: specializationResult.rows.map(r => r.field_of_study),
        });

    } catch (err) {
        console.error("Get education list error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};
exports.getCompanyList = async (req, res) => {
    try {
        const { company_search = "", title_search = "" } = req.query;

        // 🎯 Company query — UNION company names from experiences and organizations table (type: COMPANY), de-duplicating case-insensitively
        let companyQuery, companyParams;
        if (company_search) {
            companyParams = [`%${company_search}%`];
            companyQuery = `
                WITH combined AS (
                    SELECT company_name
                    FROM experiences
                    WHERE company_name IS NOT NULL AND company_name != ''
                      AND LOWER(company_name) LIKE LOWER($1)
                    UNION
                    SELECT name AS company_name
                    FROM organizations
                    WHERE name IS NOT NULL AND name != ''
                      AND entity_type = 'COMPANY'
                      AND is_deleted = FALSE
                      AND LOWER(name) LIKE LOWER($1)
                )
                SELECT DISTINCT ON (LOWER(TRIM(company_name))) company_name
                FROM combined
                ORDER BY LOWER(TRIM(company_name))
                LIMIT 50`;
        } else {
            companyParams = [];
            companyQuery = `
                WITH combined AS (
                    SELECT company_name
                    FROM experiences
                    WHERE company_name IS NOT NULL AND company_name != ''
                    UNION
                    SELECT name AS company_name
                    FROM organizations
                    WHERE name IS NOT NULL AND name != ''
                      AND entity_type = 'COMPANY'
                      AND is_deleted = FALSE
                )
                SELECT DISTINCT ON (LOWER(TRIM(company_name))) company_name
                FROM combined
                ORDER BY LOWER(TRIM(company_name))
                LIMIT 50`;
        }

        // 🎯 Title query — case-insensitive DISTINCT via DISTINCT ON
        let titleQuery, titleParams;
        if (title_search) {
            titleParams = [`%${title_search}%`];
            titleQuery = `
                SELECT DISTINCT ON (LOWER(TRIM(title))) title
                FROM experiences
                WHERE title IS NOT NULL AND title != ''
                  AND LOWER(title) LIKE LOWER($1)
                ORDER BY LOWER(TRIM(title))
                LIMIT 50`;
        } else {
            titleParams = [];
            titleQuery = `
                SELECT DISTINCT ON (LOWER(TRIM(title))) title
                FROM experiences
                WHERE title IS NOT NULL AND title != ''
                ORDER BY LOWER(TRIM(title))
                LIMIT 50`;
        }

        // 🔥 Run both queries separately
        const [companyResult, titleResult] = await Promise.all([
            pool.query(companyQuery, companyParams),
            pool.query(titleQuery, titleParams),
        ]);

        return res.json({
            titles: titleResult.rows.map(r => r.title),
            company_names: companyResult.rows.map(r => r.company_name),
        });

    } catch (err) {
        console.error("Get company list error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
};
// ─── Batch Experience API ───────────────────────────────────────────────────────

const operationSchema = z.discriminatedUnion("type", [
    z.object({
        type: z.literal("CREATE"),
        tempId: z.string(),
        data: z.object({
            title: z.string().min(1, "Title is required"),
            company_name: z.string().min(1, "Company name is required"),
            location: z.string().nullable().optional(),
            work_type: z.string().nullable().optional(),
            work_mode: z.string().nullable().optional(),
            start_date: z.string(),
            end_date: z.string().nullable().optional(),
            is_current: z.boolean().optional(),
            description: z.string().nullable().optional(),
            org_id: z.string().uuid().nullable().optional(),
        }),
    }),
    z.object({
        type: z.literal("UPDATE"),
        id: z.string().uuid(),
        data: z.object({
            title: z.string().optional(),
            company_name: z.string().optional(),
            location: z.string().nullable().optional(),
            work_type: z.string().nullable().optional(),
            work_mode: z.string().nullable().optional(),
            start_date: z.string().optional(),
            end_date: z.string().nullable().optional(),
            is_current: z.boolean().optional(),
            description: z.string().nullable().optional(),
            org_id: z.string().uuid().nullable().optional(),
        }),
    }),
    z.object({
        type: z.literal("DELETE"),
        id: z.string().uuid(),
    }),
]);

const batchSchema = z.object({
    requestId: z.string(),
    version: z.number(),
    operations: z.array(operationSchema),
});

exports.batchUpdateExperiences = async (req, res) => {
    const parseResult = batchSchema.safeParse(req.body);
    if (!parseResult.success) {
        return res.status(400).json({
            message: "Invalid batch payload",
            errors: parseResult.error.errors
        });
    }

    const { requestId, version, operations } = parseResult.data;
    const userId = req.user.sub;

    // 1. Idempotency Check
    const cached = await profileRepo.getIdempotentResponse(requestId);
    if (cached) {
        return res.status(cached.status_code).json(JSON.parse(cached.response_body));
    }

    const client = await pool.connect();
    try {
        const profileId = await profileRepo.ensureProfileId(userId);
        const currentVersion = await profileRepo.getProfileVersion(profileId);

        // 2. Concurrency Control (Optimistic Locking)
        if (currentVersion !== version) {
            const errorResponse = {
                message: "Profile has been updated by another request. Please refresh.",
                code: "VERSION_CONFLICT",
                currentVersion
            };
            return res.status(409).json(errorResponse);
        }

        // 3. Pre-validation & Simulation
        const existingExperiences = await profileRepo.getExperiencesByProfileId(profileId);
        let simulatedState = existingExperiences.map(e => ({ ...e }));
        const errors = [];

        // Apply operations to simulated state
        for (let i = 0; i < operations.length; i++) {
            const op = operations[i];
            const opPathPrefix = `experiences.${i}`;

            if (op.type === "DELETE") {
                simulatedState = simulatedState.filter(e => e.experience_id !== op.id);
            } else if (op.type === "UPDATE") {
                const idx = simulatedState.findIndex(e => e.experience_id === op.id);
                if (idx === -1) {
                    errors.push({ path: opPathPrefix, message: "Experience not found" });
                    continue;
                }
                simulatedState[idx] = { ...simulatedState[idx], ...op.data };
                // Basic date validation
                const { start_date, end_date, is_current } = simulatedState[idx];
                if (!is_current && !end_date) {
                    errors.push({ path: `${opPathPrefix}.end_date`, message: "End date is required" });
                }
                if (end_date && new Date(end_date) < new Date(start_date)) {
                    errors.push({ path: `${opPathPrefix}.end_date`, message: "End date must be after start date" });
                }
            } else if (op.type === "CREATE") {
                const newExp = { 
                    experience_id: op.tempId, // temporary ID for simulation
                    ...op.data,
                    profile_id: profileId 
                };
                simulatedState.push(newExp);
                // Basic date validation
                const { start_date, end_date, is_current } = newExp;
                if (!is_current && !end_date) {
                    errors.push({ path: `${opPathPrefix}.data.end_date`, message: "End date is required" });
                }
                if (end_date && new Date(end_date) < new Date(start_date)) {
                    errors.push({ path: `${opPathPrefix}.data.end_date`, message: "End date must be after start date" });
                }
            }
        }

        if (errors.length > 0) {
            const errorResponse = { message: "Validation failed", errors };
            return res.status(422).json(errorResponse);
        }

        // Cross-experience validation on simulated state
        for (let i = 0; i < simulatedState.length; i++) {
            const expA = simulatedState[i];
            const companyNormA = (expA.company_name || "").trim().toLowerCase();
            const endA = expA.is_current ? null : expA.end_date;

            // Same-company overlap check
            for (let j = i + 1; j < simulatedState.length; j++) {
                const expB = simulatedState[j];
                const companyNormB = (expB.company_name || "").trim().toLowerCase();
                const endB = expB.is_current ? null : expB.end_date;

                // align with DB index idx_one_current_role_per_company which is name-based
                const isSameCompany = (expA.org_id && expB.org_id && expA.org_id === expB.org_id) ||
                                     (companyNormA === companyNormB);

                if (isSameCompany && datesOverlap(expA.start_date, endA, expB.start_date, endB)) {
                    // Find which operation caused this (if any)
                    const opIdx = operations.findIndex(op => 
                        (op.type === "CREATE" && op.tempId === expA.experience_id) ||
                        (op.type === "UPDATE" && op.id === expA.experience_id) ||
                        (op.type === "CREATE" && op.tempId === expB.experience_id) ||
                        (op.type === "UPDATE" && op.id === expB.experience_id)
                    );
                    const path = opIdx !== -1 ? `experiences.${opIdx}` : 'global';
                    errors.push({ 
                        path, 
                        message: `Date overlap detected at "${expA.company_name}".` 
                    });
                }
            }
        }

        // Multiple current roles check
        const activeRoles = simulatedState.filter(e => e.is_current || !e.end_date);
        if (activeRoles.length > 1) {
            // Find the newest current role
            const newest = [...activeRoles].sort((a, b) => new Date(b.start_date) - new Date(a.start_date))[0];
            const severity = getMultipleCurrentSeverity(activeRoles.filter(r => r.experience_id !== newest.experience_id), newest.work_type, newest.work_mode);
            
            if (severity === 'block') {
                const opIdx = operations.findIndex(op => 
                    (op.type === "CREATE" && op.tempId === newest.experience_id) ||
                    (op.type === "UPDATE" && op.id === newest.experience_id)
                );
                errors.push({ 
                    path: opIdx !== -1 ? `experiences.${opIdx}.is_current` : 'global',
                    message: describeConflict(activeRoles.filter(r => r.experience_id !== newest.experience_id), newest.work_type, newest.work_mode, severity)
                });
            }
        }

        if (errors.length > 0) {
            const errorResponse = { message: "Validation failed", errors };
            return res.status(422).json(errorResponse);
        }

        // 4. Transactional Execution
        await client.query('BEGIN');

        const idMap = {}; // tempId -> databaseId
        const affectedOrgIds = [];

        // Execute DELETEs first, then UPDATEs, then CREATEs to avoid transient constraint violations
        const deleteOps = operations.filter(op => op.type === "DELETE");
        const updateOps = operations.filter(op => op.type === "UPDATE");
        const createOps = operations.filter(op => op.type === "CREATE");

        for (const op of deleteOps) {
            const deleted = await profileRepo.deleteExperienceInTx(client, op.id, profileId);
            if (deleted && deleted.org_id) {
                affectedOrgIds.push(deleted.org_id);
            }
        }
        for (const op of updateOps) {
            const existing = existingExperiences.find(e => e.experience_id === op.id);
            if (existing && existing.org_id) {
                affectedOrgIds.push(existing.org_id);
            }
            await handleExperienceOrgLink(client, userId, op.data);
            if (op.data.org_id) {
                affectedOrgIds.push(op.data.org_id);
            }
            await profileRepo.updateExperienceInTx(client, op.id, profileId, op.data);
        }
        for (const op of createOps) {
            await handleExperienceOrgLink(client, userId, op.data);
            if (op.data.org_id) {
                affectedOrgIds.push(op.data.org_id);
            }
            const newExp = await profileRepo.addExperienceInTx(client, profileId, op.data);
            idMap[op.tempId] = newExp.experience_id;
        }

        // Clean up previous memberships
        await cleanupPreviousCompanyMemberships(client, userId, affectedOrgIds);

        // Increment version
        const newVersion = await profileRepo.incrementProfileVersion(client, profileId, version);
        if (!newVersion) {
            await client.query('ROLLBACK');
            return res.status(409).json({ message: "Version conflict during commit", code: "VERSION_CONFLICT" });
        }

        await client.query('COMMIT');

        const successResponse = { 
            message: "Batch update successful", 
            idMap, 
            newVersion 
        };
        
        // 5. Save Idempotent Response
        await profileRepo.saveIdempotentResponse(requestId, 200, successResponse);

        res.json(successResponse);

    } catch (err) {
        if (client) await client.query('ROLLBACK');
        console.error("Batch experience update error:", err);

        // Handle specific Postgres error codes
        if (err.code === '23505') { // Unique Violation
            return res.status(409).json({ 
                message: "Conflict detected: Multiple current roles at the same company or duplicate entry.",
                code: "UNIQUE_VIOLATION"
            });
        }
        if (err.code === '23514') { // Check Constraint Violation
            return res.status(422).json({ 
                message: "Data integrity violation: Ensure dates are valid and start date is before end date.",
                code: "CHECK_VIOLATION"
            });
        }

        res.status(500).json({ message: "Internal server error during batch update" });
    } finally {
        if (client) client.release();
    }
};
