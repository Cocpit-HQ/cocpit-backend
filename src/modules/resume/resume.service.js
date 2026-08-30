const { mapProfileToResumeTemplate } = require('./resume.mapper');
const { renderResumePdf } = require('./resume.renderer');

/**
 * Service to orchestrate the creation of a profile resume PDF
 */
async function generateProfileResumePdf(profileData) {
    // 1. Map the raw profile data to the template structure
    const mappedData = mapProfileToResumeTemplate(profileData);

    // 2. We can eventually add logic to select a template based on user settings
    // For now, we only have 'default'
    const templateName = 'default';

    // 3. Render the PDF
    const pdfBuffer = await renderResumePdf(mappedData, templateName);

    return pdfBuffer;
}

module.exports = {
    generateProfileResumePdf
};
