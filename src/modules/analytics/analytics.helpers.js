const dateFns = require("date-fns");

/**
 * Resolves start, end, previousStart, and previousEnd dates based on a filter.
 * filter: 'last_7_days', 'last_30_days', 'all_time', 'custom'
 * custom requires startDate and endDate (ISO strings)
 * all_time requires userCreatedAt
 */
const resolveDateRange = (filter, startDate, endDate, userCreatedAt) => {
    const now = new Date();
    let start, end, previousStart, previousEnd;

    // Add a 5 minute buffer to the current time to account for clock skew between API and DB servers
    end = dateFns.addMinutes(now, 5);
    previousEnd = null;
    previousStart = null;

    switch (filter) {
        case 'last_7_days':
            start = dateFns.subDays(now, 7);
            previousEnd = start;
            previousStart = dateFns.subDays(previousEnd, 7);
            break;
        case 'all_time':
            start = userCreatedAt ? new Date(userCreatedAt) : new Date(0);
            break;
        case 'custom':
            start = new Date(startDate);
            end = new Date(endDate);
            // Calculate previous period of same duration
            const durationMs = end.getTime() - start.getTime();
            previousEnd = start;
            previousStart = new Date(previousEnd.getTime() - durationMs);
            break;
        case 'last_30_days':
        default:
            start = dateFns.subDays(now, 30);
            previousEnd = start;
            previousStart = dateFns.subDays(previousEnd, 30);
            break;
    }

    return { start, end, previousStart, previousEnd };
};

/**
 * Calculates percentage trend between two values.
 * Returns formatted string like "+12%" or "Stable".
 */
const calculateTrend = (current, previous) => {
    if (previous === 0 && current === 0) return "Stable";
    if (previous === 0 && current > 0) return "+100%"; // Or some other max positive
    
    const diff = current - previous;
    const percent = (diff / previous) * 100;
    const rounded = Number(percent.toFixed(1));
    
    if (rounded === 0) return "Stable";
    return rounded > 0 ? `+${rounded}%` : `${rounded}%`;
};

/**
 * Formats large numbers into k/m strings (e.g. 12400 -> "12.4k")
 */
const formatNumber = (num) => {
    if (num >= 1000000) return (num / 1000000).toFixed(1).replace(/\.0$/, '') + 'm';
    if (num >= 1000) return (num / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
    return num.toString();
};

/**
 * Generates an array of all dates between start and end (inclusive)
 */
const generateDateRange = (start, end) => {
    const dates = [];
    let curr = new Date(start);
    const endStr = dateFns.format(end, 'yyyy-MM-dd');
    
    while (dateFns.format(curr, 'yyyy-MM-dd') <= endStr) {
        dates.push(dateFns.format(curr, 'yyyy-MM-dd'));
        curr = dateFns.addDays(curr, 1);
    }
    return dates;
};

/**
 * Formats industry names to expected camel/Pascal case (e.g. information_technology -> InformationTechnology)
 */
const formatIndustryName = (name) => {
    if (!name || name === 'Other') return name;
    return name
        .split(/[_\s]+/)
        .map(word => {
            if (word.toLowerCase() === 'saas') return 'SaaS';
            if (word.toLowerCase() === 'ui') return 'UI';
            if (word.toLowerCase() === 'ux') return 'UX';
            if (word.toLowerCase() === 'it') return 'IT';
            return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
        })
        .join(' ');
};

module.exports = {
    resolveDateRange,
    calculateTrend,
    formatNumber,
    generateDateRange,
    formatIndustryName
};
