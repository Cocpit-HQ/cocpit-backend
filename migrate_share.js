const fs = require('fs');
const socialPath = 'c:/Users/user3/Desktop/cocpit/cocpit-backend/src/modules/social/social.controller.js';
const sharePath = 'c:/Users/user3/Desktop/cocpit/cocpit-backend/src/modules/share/share.controller.js';

let socialCode = fs.readFileSync(socialPath, 'utf8');
let shareCode = fs.readFileSync(sharePath, 'utf8');

// 1. Extract shareProfile from socialCode
const socialMatch = socialCode.match(/(exports\.shareProfile = async \(req, res\) => \{[\s\S]*?\n\};)/);
if (!socialMatch) {
    console.error("Could not find shareProfile in social.controller.js!");
    process.exit(1);
}

let newShareProfile = socialMatch[1];
// Inject local requires
newShareProfile = newShareProfile.replace(
    'exports.shareProfile = async (req, res) => {',
    'exports.shareProfile = async (req, res) => {\n    const pool = require("../../core/db/pool");\n    const socketService = require("../../core/infrastructure/socket.service");'
);

// 2. Extract shareProfile from shareCode and Replace
const shareMatch = shareCode.match(/(exports\.shareProfile = async \(req, res\) => \{[\s\S]*?\n\};)/);
if (!shareMatch) {
    console.error("Could not find shareProfile in share.controller.js!");
    process.exit(1);
}

shareCode = shareCode.replace(shareMatch[1], newShareProfile);

// 3. Delete shareProfile from socialCode
socialCode = socialCode.replace(socialMatch[1], '');
// Also remove the preceding JSDoc comment for shareProfile in socialCode
socialCode = socialCode.replace(/\/\*\*\s*\n\s*\*\s*Internal Profile Sharing[\s\S]*?\*\/\n/, '');

// 4. Rename companies to organizations in shareCode
// Functions check: `shareProfileInDM`, `sharePostToConversations`
shareCode = shareCode.replace(/company_members/g, 'organization_members');
shareCode = shareCode.replace(/companies/g, 'organizations');

// Carefully replace cp1.company_id to cp1.org_id in queries
shareCode = shareCode.replace(/company_id = \$1/g, 'org_id = $1');
shareCode = shareCode.replace(/company_id = \$2/g, 'org_id = $2');
shareCode = shareCode.replace(/cp1\.company_id/g, 'cp1.org_id');
shareCode = shareCode.replace(/cp2\.company_id/g, 'cp2.org_id');
shareCode = shareCode.replace(/\(conversation_id, company_id\)/g, '(conversation_id, org_id)');

// Note: senderCompanyId variable name is kept as is because it's part of req.body which might be used by frontend
// Also recipient_company_id should be recipient_org_id in notifications
shareCode = shareCode.replace(/recipient_company_id/g, 'recipient_org_id');

fs.writeFileSync(sharePath, shareCode);
fs.writeFileSync(socialPath, socialCode);

console.log("Migration and renaming complete.");
