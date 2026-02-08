require('dotenv').config();
const { signAccessToken } = require('../src/utils/jwt');

const token = signAccessToken({
    sub: '5bc56581-558e-4c6b-a0f3-01f2638b3eef', // User ID from original receiver.js
    sid: 'test-session-' + Date.now(),
    roles: ['Admin']
});

console.log('GENERATED_TOKEN:', token);
require('fs').writeFileSync('token.txt', token);
