/**
 * Helper utilities for Persona-Based Access
 */

exports.isStudent = (profile) => {
    return profile?.accountType === 'Student' || profile?.accountType === 'Currently not working';
};

exports.isFresher = (profile) => {
    return profile?.accountType === 'Fresher' || profile?.accountType === 'Currently not working';
};

exports.isEmployee = (profile) => {
    return profile?.accountType === 'Employed' || profile?.accountType === 'Intern';
};

exports.isFreelancer = (profile) => {
    return profile?.accountType === 'Self-employed';
};
