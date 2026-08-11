const fs = require('fs');
const path = require('path');
const handlebars = require('handlebars');
const puppeteer = require('puppeteer');

/**
 * Renders the resume template into a PDF Buffer
 * @param {Object} mappedData - The data object prepared by the mapper
 * @param {string} templateName - The name of the template (defaults to 'default')
 * @returns {Promise<Buffer>} - The generated PDF buffer
 */
async function renderResumePdf(mappedData, templateName = 'default') {
    // 1. Load the Handlebars template
    const templatePath = path.join(__dirname, 'templates', templateName, 'template.hbs');
    if (!fs.existsSync(templatePath)) {
        throw new Error(`Template '${templateName}' not found.`);
    }

    const templateSource = fs.readFileSync(templatePath, 'utf8');
    const template = handlebars.compile(templateSource);

    // 2. Generate HTML string
    const htmlContent = template(mappedData);

    // 3. Launch Puppeteer to render HTML into PDF
    const browser = await puppeteer.launch({
        headless: 'new', // Use the new headless mode
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });

    try {
        const page = await browser.newPage();
        
        // Wait until there are no more than 0 network connections for at least 500ms
        await page.setContent(htmlContent, { waitUntil: 'networkidle0' });
        
        // Ensure webfonts (like Fira Mono) are fully loaded
        await page.evaluateHandle('document.fonts.ready');

        // Generate PDF
        const pdfBuffer = await page.pdf({
            format: 'Letter',
            printBackground: true,
            tagged: true, // Enhances ATS parsing by embedding semantic tags
            margin: {
                top: '0.5in',
                right: '0.5in',
                bottom: '0.5in',
                left: '0.5in',
            },
        });

        return pdfBuffer;
    } finally {
        await browser.close();
    }
}

module.exports = {
    renderResumePdf
};
