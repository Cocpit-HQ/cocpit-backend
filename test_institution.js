require("dotenv").config({ path: "C:\\Users\\user2\\Desktop\\test\\cocpit-backend\\.env" });
const { signAccessToken } = require("C:\\Users\\user2\\Desktop\\test\\cocpit-backend\\src\\core\\utils\\jwt.js");
const axios = require("axios");

async function testInstitutionCreation() {
    try {
        const userId = "6761c039-1c93-4aa8-bf92-9286d7a384c4"; // test@gmail.com
        const token = signAccessToken({ sub: userId, email: "test@gmail.com", userType: "USER", status: "ACTIVE" });

        console.log("Creating institution...");
        const res = await axios.post("http://localhost:5000/api/companies", {
            name: "Stanford University Test",
            slug: `stanford-test-${Date.now()}`,
            email: "admissions@stanford.edu",
            industry: "Higher Education",
            size: "10001+",
            website: "https://stanford.edu",
            location: "Stanford, CA",
            description: "Test institution creation",
            entity_type: "INSTITUTION"
        }, {
            headers: { Authorization: `Bearer ${token}` }
        });

        console.log("\n✅ Institution created:", res.data.company.name, "| Type:", res.data.company.entity_type);
        const orgId = res.data.company.org_id;

        console.log("\nChecking created roles for org:", orgId);
        const rolesRes = await axios.get(`http://localhost:5000/api/companies/${orgId}/roles`, {
            headers: { Authorization: `Bearer ${token}`, "x-company-id": orgId }
        });

        console.log("\nRoles created:");
        rolesRes.data.forEach(r => console.log(`- ${r.name} (${r.permissions.length} perms) [System: ${r.is_system_role}]`));

        console.log("\nTesting Enrollment Request...");
        const enrollRes = await axios.post(`http://localhost:5000/api/companies/${orgId}/enroll`, {
            role: "STUDENT",
            method: "EMAIL"
        }, {
            headers: { Authorization: `Bearer ${token}` }
        });
        console.log("\n✅ Enrollment requested:", enrollRes.data.enrollment.status, "| Role:", enrollRes.data.enrollment.role);

    } catch (err) {
        if (err.response) {
            console.error(`❌ API Error [${err.response.status}]:`, err.response.data);
        } else {
            console.error("❌ Error:", err.message);
        }
    }
}

testInstitutionCreation();
