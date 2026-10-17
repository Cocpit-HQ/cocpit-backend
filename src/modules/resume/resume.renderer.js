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
        channel: 'chrome', // Force using system-installed Chrome (bypasses Windows Smart App Control / Code Integrity policies)
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });

    try {
        const page = await browser.newPage();
        
        // Wait until there are no more than 0 network connections for at least 500ms
        await page.setContent(htmlContent, { waitUntil: 'networkidle0' });
        
        // Ensure webfonts (like Fira Mono) are fully loaded
        await page.evaluateHandle('document.fonts.ready');

        // Footer template with Cocpit logo positioned safely in the page bottom margin
        const footerTemplate = `
            <div style="-webkit-print-color-adjust: exact; width: 100%; box-sizing: border-box; padding-right: 0.5in; padding-bottom: 0.05in; display: flex; justify-content: flex-end; align-items: flex-end;">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="30" height="34" fill="none">
                    <g fill="#000000">
                        <path fill-rule="evenodd" clip-rule="evenodd" d="M 678.68 262.00 L 729.00 261.69 L 731.47 263.00 L 731.21 361.00 L 729.00 362.60 L 699.00 363.96 L 684.00 366.09 L 659.00 372.63 L 648.00 377.29 L 637.00 383.88 L 627.00 392.12 L 620.32 400.00 L 611.55 415.00 L 607.00 429.26 L 604.78 441.00 L 603.28 459.00 L 602.66 539.00 L 600.00 539.94 L 476.52 540.00 L 475.46 538.00 L 474.78 520.00 L 474.79 414.00 L 476.68 393.00 L 481.00 370.17 L 485.29 357.00 L 490.00 346.24 L 500.36 330.00 L 515.00 314.07 L 533.66 299.00 L 552.27 288.00 L 573.00 279.30 L 594.00 272.68 L 615.00 268.18 L 648.00 263.92 L 678.68 262.00 Z M 290.82 462.00 L 410.47 462.00 L 411.34 464.00 L 410.90 542.00 L 413.63 564.00 L 418.28 579.00 L 424.77 592.00 L 438.00 608.84 L 454.97 622.00 L 467.00 628.44 L 484.00 635.03 L 500.00 639.26 L 533.00 643.33 L 601.00 643.71 L 603.00 644.79 L 603.00 758.41 L 598.00 759.52 L 531.00 758.55 L 471.00 754.55 L 440.00 750.09 L 417.00 743.54 L 388.00 730.68 L 361.00 713.33 L 340.00 695.54 L 322.68 676.00 L 314.00 662.90 L 303.00 638.72 L 294.06 609.00 L 289.94 573.00 L 289.91 464.00 L 290.82 462.00 Z" />
                    </g>
                </svg>
            </div>
        `;

        // Generate PDF
        const pdfBuffer = await page.pdf({
            format: 'A4',
            printBackground: true,
            tagged: true, // Enhances ATS parsing by embedding semantic tags
            displayHeaderFooter: true,
            headerTemplate: '<span></span>',
            footerTemplate: footerTemplate,
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
