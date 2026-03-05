const axios = require('axios');
const crypto = require('crypto');

const BASE_URL = 'http://localhost:5000/api';

async function runTests() {
    console.log('Starting Backend API Regression Tests...');
    const testId = crypto.randomUUID().substring(0, 8);
    const email = `testuser_${testId}@example.com`;
    const password = 'Password123!';

    let api = axios.create({
        baseURL: BASE_URL,
        validateStatus: () => true // Don't throw on error status codes
    });

    try {
        // 1. Register User
        console.log(`\n--- Registering User (${email}) ---`);
        let res = await api.post('/auth/register', {
            email,
            password,
            fullName: 'Test User',
            accountType: 'Student'
        });
        console.log(res.status, res.data);
        if (res.status > 201) throw new Error('Registration failed');

        // 2. Login
        console.log('\n--- Logging In ---');
        res = await api.post('/auth/login', { email, password });
        console.log(res.status, Object.keys(res.data));
        if (res.status !== 200) throw new Error('Login failed');

        const token = res.data.accessToken;
        api.defaults.headers.common['Authorization'] = `Bearer ${token}`;

        // 3. Create Company (Legacy flow check - R1)
        console.log('\n--- R1: Create Company ---');
        const companySlug = `test-corp-${testId}`;
        res = await api.post('/organizations', {
            name: `Test Corp ${testId}`,
            slug: companySlug,
            industry: 'Software',
            size: '1-10',
            description: 'A test company'
        });
        console.log(res.status, res.data.organization ? res.data.organization.name : res.data);
        if (res.status > 201) throw new Error('Create Company failed');

        // 4. Create Institution (New flow check - I1)
        console.log('\n--- I1: Create Institution ---');
        const institutionSlug = `test-uni-${testId}`;
        res = await api.post('/organizations', {
            name: `Test University ${testId}`,
            slug: institutionSlug,
            entity_type: 'INSTITUTION',
            institution_type: 'University',
            established_year: 1990
        });
        console.log(res.status, res.data.organization ? res.data.organization.name : res.data);
        if (res.status > 201) throw new Error('Create Institution failed');
        const instId = res.data.organization.org_id;

        // 5. Test Institution Roles (I2 approximation - fetching roles via API)
        console.log('\n--- I2: Get Institution Roles ---');
        res = await api.get(`/organizations/${instId}/roles`);
        console.log(res.status, res.data.roles ? res.data.roles.map(r => r.name) : res.data);

        // 6. Test Get Organization 
        console.log('\n--- R2: Get Organization by Slug ---');
        res = await api.get(`/organizations/${companySlug}`);
        console.log(res.status, res.data.organization ? res.data.organization.name : res.data.message);

        console.log('\n✅ All API Integration Tests Completed Successfully!');
    } catch (err) {
        console.error(`\n❌ Tests Failed: ${err.message}`);
    }
}

runTests();
