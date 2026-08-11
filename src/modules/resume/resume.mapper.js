const { format, parseISO, isValid } = require('date-fns');

/**
 * Parses and formats a date string to "MMM yyyy" (e.g., "Aug. 2019")
 */
function formatDate(dateString) {
    if (!dateString) return '';
    try {
        const date = typeof dateString === 'string' ? parseISO(dateString) : new Date(dateString);
        if (!isValid(date)) return '';
        return format(date, 'MMM. yyyy');
    } catch (err) {
        return '';
    }
}

/**
 * Creates a "Start Date - End Date" or "Start Date - Present" string
 */
function formatDateRange(startDate, endDate, isCurrent = false) {
    if (!startDate && !endDate && !isCurrent) return '';
    const startStr = formatDate(startDate) || 'Unknown';
    const endStr = isCurrent ? 'Present' : (formatDate(endDate) || 'Present');
    return `${startStr} -- ${endStr}`;
}

/**
 * Splits a text block into bullet points based on line breaks or specific characters.
 */
function extractBulletPoints(text) {
    if (!text) return [];
    // Assuming the user might use newlines, bullet characters, or hyphens
    return text.split(/\n+/)
        .map(line => line.replace(/^[\u2022\u25E6\u25A0\-\*]\s*/, '').trim())
        .filter(line => line.length > 0);
}

/**
 * Maps the raw database profile data into the structured format required by the template.
 */
function mapProfileToResumeTemplate(profileData) {
    const { user, experiences = [], educations = [], projects = [], skills = [] } = profileData;

    // Map User (Header) & Validate Social Links
    const allowedDomains = ['linkedin.com', 'github.com', 'leetcode.com'];
    const contactItems = [];

    const icons = {
        phone: '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"></path></svg>',
        email: '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"></path><polyline points="22,6 12,13 2,6"></polyline></svg>',
        location: '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path><circle cx="12" cy="10" r="3"></circle></svg>',
        linkedin: '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24"><path fill="currentColor" d="M19 3a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zm-.5 15.5v-5.3a3.26 3.26 0 0 0-3.26-3.26c-.85 0-1.84.52-2.32 1.3v-1.11h-2.79v8.37h2.79v-4.93c0-.77.62-1.4 1.39-1.4a1.4 1.4 0 0 1 1.4 1.4v4.93zM6.88 8.56a1.68 1.68 0 0 0 1.68-1.68c0-.93-.75-1.69-1.68-1.69a1.69 1.69 0 0 0-1.69 1.69c0 .93.76 1.68 1.69 1.68m1.39 9.94v-8.37H5.5v8.37z"/></svg>',
        github: '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24"><path fill="currentColor" d="M12 2A10 10 0 0 0 2 12c0 4.42 2.87 8.17 6.84 9.5c.5.08.66-.23.66-.5v-1.69c-2.77.6-3.36-1.34-3.36-1.34c-.46-1.16-1.11-1.47-1.11-1.47c-.91-.62.07-.6.07-.6c1 .07 1.53 1.03 1.53 1.03c.87 1.52 2.34 1.07 2.91.83c.09-.65.35-1.09.63-1.34c-2.22-.25-4.55-1.11-4.55-4.92c0-1.11.38-2 1.03-2.71c-.1-.25-.45-1.29.1-2.64c0 0 .84-.27 2.75 1.02c.79-.22 1.65-.33 2.5-.33s1.71.11 2.5.33c1.91-1.29 2.75-1.02 2.75-1.02c.55 1.35.2 2.39.1 2.64c.65.71 1.03 1.6 1.03 2.71c0 3.82-2.34 4.66-4.57 4.91c.36.31.69.92.69 1.85V21c0 .27.16.59.67.5C19.14 20.16 22 16.42 22 12A10 10 0 0 0 12 2"/></svg>',
        link: '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg>'
    };

    if (user.mobile_number) contactItems.push({ text: user.mobile_number, icon: icons.phone });
    if (user.email) contactItems.push({ text: user.email, icon: icons.email });
    if (user.location) contactItems.push({ text: user.location, icon: icons.location });

    // 1. By default, add the link of the cocpit profile
    if (user.account_name) {
        let baseUrl = user.client_origin || process.env.CLIENT_URL || 'http://localhost:3000';
        if (baseUrl.endsWith('/')) baseUrl = baseUrl.slice(0, -1);
        
        const profileUrl = `${baseUrl}/profile/${user.account_name}`;
        const displayUrl = 'cocpit.in';
        
        contactItems.push({ 
            url: profileUrl, 
            display: displayUrl,
            icon: icons.link
        });
    }

    // 2. Strictly only allow specific links, ignore youtube/insta etc.
    if (user.website) {
        let websiteUrl = user.website.trim();
        if (!websiteUrl.match(/^https?:\/\//i)) {
            websiteUrl = 'https://' + websiteUrl;
        }
        
        try {
            const urlObj = new URL(websiteUrl);
            const domain = urlObj.hostname.replace(/^www\./i, '').toLowerCase();
            
            if (allowedDomains.some(d => domain === d || domain.endsWith('.' + d))) {
                // "dont afdd whole line just a domain and this wlll redirect to that"
                let iconType = icons.link;
                if (domain.includes('linkedin')) iconType = icons.linkedin;
                if (domain.includes('github')) iconType = icons.github;

                contactItems.push({ 
                    url: websiteUrl, 
                    display: domain,
                    icon: iconType
                });
            }
        } catch (e) {
            // Invalid URL, ignore
        }
    }

    const templateUser = {
        name: user.name || 'Anonymous User',
        contactItems: contactItems
    };

    // Map Experiences (handle both grouped and flat arrays)
    const flatExperiences = [];
    experiences.filter(Boolean).forEach(exp => {
        if (Array.isArray(exp.experiences)) {
            exp.experiences.forEach(innerExp => {
                flatExperiences.push({
                    company_name: exp.company_name || innerExp.company_name || 'Unknown Company',
                    title: innerExp.title || 'Unknown Title',
                    location: innerExp.location || '',
                    date_range: formatDateRange(innerExp.start_date, innerExp.end_date, innerExp.is_current),
                    bullet_points: extractBulletPoints(innerExp.description)
                });
            });
        } else {
            flatExperiences.push({
                company_name: exp.company_name || 'Unknown Company',
                title: exp.title || 'Unknown Title',
                location: exp.location || '',
                date_range: formatDateRange(exp.start_date, exp.end_date, exp.is_current),
                bullet_points: extractBulletPoints(exp.description)
            });
        }
    });
    const templateExperiences = flatExperiences;

    // Map Projects
    const templateProjects = projects
        .filter(proj => proj)
        .map(proj => {
            let startStr = (proj.start_month && proj.start_year) ? `${proj.start_month} ${proj.start_year}` : '';
            let endStr = proj.is_current ? 'Present' : ((proj.end_month && proj.end_year) ? `${proj.end_month} ${proj.end_year}` : '');
            let date_range = (startStr || endStr) ? `${startStr} -- ${endStr}` : '';
            
            const bp = extractBulletPoints(proj.details);
            if (proj.role) bp.unshift(`Role: ${proj.role}`);
            if (proj.team_size) bp.unshift(`Team Size: ${proj.team_size}`);
            if (Array.isArray(proj.skills) && proj.skills.length > 0) bp.push(`Skills: ${proj.skills.join(', ')}`);
            
            return {
                name: proj.title || 'Untitled Project',
                date_range: date_range,
                bullet_points: bp
            };
        });

    // Map Educations
    const templateEducations = educations
        .filter(edu => edu)
        .map(edu => ({
            school_name: edu.school_name || edu.school || 'Unknown Institution',
            degree: edu.degree || 'Degree',
            field_of_study: edu.field_of_study || '',
            location: edu.location || '',
            date_range: formatDateRange(edu.start_date, edu.end_date, false),
            bullet_points: extractBulletPoints(edu.description)
        }));

    // Map Skills
    // If skills are just a flat array of objects like { name: 'JavaScript' }, we might group them under one category.
    // Let's check how they can be grouped. We'll put them in a single "Tools & Languages" category if there's no native category.
    const groupedSkills = {};
    skills.forEach(skill => {
        const cat = skill.category || 'Technical Skills';
        if (!groupedSkills[cat]) groupedSkills[cat] = [];
        groupedSkills[cat].push(skill.name);
    });

    const templateSkills = Object.keys(groupedSkills).map(cat => ({
        category: cat,
        items: groupedSkills[cat].join(', ')
    }));

    return {
        user: templateUser,
        experiences: templateExperiences,
        projects: templateProjects,
        educations: templateEducations,
        skills: templateSkills,
    };
}

module.exports = {
    mapProfileToResumeTemplate
};
