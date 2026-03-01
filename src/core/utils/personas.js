/**
 * Helper utilities for Persona-Based Access
 */

exports.isEmployer = (profile) => {
    return profile?.accountType === 'Employer';
};

exports.isStudent = (profile) => {
    return profile?.accountType === 'Student';
};

exports.isFresher = (profile) => {
    return profile?.accountType === 'Fresher';
};

exports.isEmployee = (profile) => {
    return profile?.accountType === 'Employee';
};

exports.isFreelancer = (profile) => {
    return profile?.accountType === 'Freelancer';
};
