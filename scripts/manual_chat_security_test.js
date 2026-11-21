#!/usr/bin/env node
/**
 * Manual & Automated Security Verification Runner for COCPIT Chat
 * Covers all 16 test cases across VULN-10, VULN-11, VULN-06, CHAT-001,
 * CHAT-002, VULN-12, VULN-15, VULN-04, VULN-05, CHAT-003, VULN-07, VULN-08.
 *
 * Usage:
 *   node scripts/manual_chat_security_test.js --dry-run
 *   node scripts/manual_chat_security_test.js --run
 *   BASE_URL=http://localhost:5000 node scripts/manual_chat_security_test.js --run
 */

const fs = require('fs');
const path = require('path');

const BASE_URL = process.env.BASE_URL || 'http://localhost:5000';
const TOKEN_USER_A = process.env.TOKEN_USER_A || 'Bearer sample-user-a-token';
const TOKEN_OUTSIDER = process.env.TOKEN_OUTSIDER || 'Bearer sample-outsider-token';
const USER_A_ID = process.env.USER_A_ID || '00000000-0000-0000-0000-000000000001';
const CONVERSATION_REQUEST_ID =
  process.env.CONVERSATION_REQUEST_ID || '11111111-1111-1111-1111-111111111111';
const GROUP_CONVERSATION_ID =
  process.env.GROUP_CONVERSATION_ID || '22222222-2222-2222-2222-222222222222';
const VICTIM_ORG_ID = process.env.VICTIM_ORG_ID || '33333333-3333-3333-3333-333333333333';
const SAMPLE_MESSAGE_ID = process.env.SAMPLE_MESSAGE_ID || '44444444-4444-4444-4444-444444444444';

const TESTS = [
  {
    id: 'TEST-01',
    vuln: 'VULN-10',
    title: "Outsider declines another user's chat request",
    method: 'PUT',
    path: `/api/conversations/${CONVERSATION_REQUEST_ID}/decline`,
    token: TOKEN_OUTSIDER,
    body: null,
    expectedStatus: 403,
    description: 'Third-party non-recipient must be rejected with 403 Forbidden',
  },
  {
    id: 'TEST-02',
    vuln: 'VULN-10',
    title: "Outsider force-accepts another user's chat request",
    method: 'PUT',
    path: `/api/conversations/${CONVERSATION_REQUEST_ID}/accept`,
    token: TOKEN_OUTSIDER,
    body: null,
    expectedStatus: 403,
    description: 'Third-party non-recipient must be rejected with 403 Forbidden',
  },
  {
    id: 'TEST-03',
    vuln: 'VULN-10',
    title: 'Request initiator attempts to accept their own request',
    method: 'PUT',
    path: `/api/conversations/${CONVERSATION_REQUEST_ID}/accept`,
    token: TOKEN_USER_A,
    body: null,
    expectedStatus: 400,
    description: 'Sender cannot accept their own pending request (400 Bad Request)',
  },
  {
    id: 'TEST-04',
    vuln: 'VULN-11',
    title: 'Non-member requests private group shared content',
    method: 'GET',
    path: `/api/groups/${GROUP_CONVERSATION_ID}/shared-content`,
    token: TOKEN_OUTSIDER,
    body: null,
    expectedStatus: 403,
    description: 'Shared files & media blocked for non-members (403 Forbidden)',
  },
  {
    id: 'TEST-05',
    vuln: 'VULN-11 & CHAT-003',
    title: 'Active group member retrieves shared content',
    method: 'GET',
    path: `/api/groups/${GROUP_CONVERSATION_ID}/shared-content`,
    token: TOKEN_USER_A,
    body: null,
    expectedStatus: 200,
    description: 'Legitimate member allowed; returns pre-signed S3/R2 download URLs',
  },
  {
    id: 'TEST-06',
    vuln: 'VULN-06',
    title: 'Non-member requests private group details & roster',
    method: 'GET',
    path: `/api/groups/${GROUP_CONVERSATION_ID}`,
    token: TOKEN_OUTSIDER,
    body: null,
    expectedStatus: 403,
    description: 'Group info & user roster blocked for non-members (403 Forbidden)',
  },
  {
    id: 'TEST-07',
    vuln: 'VULN-06',
    title: 'Active group member retrieves group details & roster',
    method: 'GET',
    path: `/api/groups/${GROUP_CONVERSATION_ID}`,
    token: TOKEN_USER_A,
    body: null,
    expectedStatus: 200,
    description: 'Legitimate member allowed to view group details',
  },
  {
    id: 'TEST-08',
    vuln: 'CHAT-001',
    title: 'User sends message with unowned authorCompanyId',
    method: 'POST',
    path: '/api/social/messages',
    token: TOKEN_OUTSIDER,
    body: {
      targetUserId: USER_A_ID,
      authorCompanyId: VICTIM_ORG_ID,
      text_content: 'Impersonation test message',
    },
    expectedStatus: 403,
    description: 'Caller not an active member of authorCompanyId (403 Forbidden)',
  },
  {
    id: 'TEST-09',
    vuln: 'CHAT-002',
    title: 'User retrieves conversations list for unowned companyId',
    method: 'GET',
    path: `/api/social/conversations?companyId=${VICTIM_ORG_ID}`,
    token: TOKEN_OUTSIDER,
    body: null,
    expectedStatus: 403,
    description: 'Caller not authorized to read company conversation list (403 Forbidden)',
  },
  {
    id: 'TEST-10',
    vuln: 'CHAT-002',
    title: 'User reads conversation message history under unowned companyId',
    method: 'GET',
    path: `/api/social/conversations/${GROUP_CONVERSATION_ID}/messages?companyId=${VICTIM_ORG_ID}`,
    token: TOKEN_OUTSIDER,
    body: null,
    expectedStatus: 403,
    description: 'Caller not authorized to read company messages (403 Forbidden)',
  },
  {
    id: 'TEST-11',
    vuln: 'VULN-12',
    title: 'User deletes conversation under unowned companyId',
    method: 'DELETE',
    path: `/api/social/conversations/${GROUP_CONVERSATION_ID}`,
    token: TOKEN_OUTSIDER,
    body: { companyId: VICTIM_ORG_ID },
    expectedStatus: 403,
    description: 'Caller not authorized to delete company conversation (403 Forbidden)',
  },
  {
    id: 'TEST-12',
    vuln: 'VULN-15',
    title: 'User pins/unpins message under unowned companyId',
    method: 'POST',
    path: `/api/social/messages/${SAMPLE_MESSAGE_ID}/pin`,
    token: TOKEN_OUTSIDER,
    body: { companyId: VICTIM_ORG_ID },
    expectedStatus: 403,
    description: 'Caller not authorized to pin/unpin for company (403 Forbidden)',
  },
  {
    id: 'TEST-13',
    vuln: 'VULN-04',
    title: 'Non-participant deletes message for themselves',
    method: 'DELETE',
    path: `/api/messaging/messages/${SAMPLE_MESSAGE_ID}`,
    token: TOKEN_OUTSIDER,
    body: { deleteForEveryone: false },
    expectedStatus: 403,
    description: 'Outsider cannot modify messages in conversation (403 Forbidden)',
  },
  {
    id: 'TEST-14',
    vuln: 'VULN-05',
    title: 'Non-participant attempts to react to message',
    method: 'POST',
    path: '/api/social/messages/reaction',
    token: TOKEN_OUTSIDER,
    body: { message_id: SAMPLE_MESSAGE_ID, emoji: '👍' },
    expectedStatus: 403,
    description: 'Non-participant rejected from reacting (403 Forbidden)',
  },
  {
    id: 'TEST-15',
    vuln: 'VULN-05',
    title: 'Participant submits malicious script/invalid emoji reaction',
    method: 'POST',
    path: '/api/social/messages/reaction',
    token: TOKEN_USER_A,
    body: { message_id: SAMPLE_MESSAGE_ID, emoji: '<script>alert(1)</script>' },
    expectedStatus: 400,
    description: 'Invalid non-emoji or long string rejected (400 Bad Request)',
  },
  {
    id: 'TEST-16',
    vuln: 'VULN-07',
    title: 'Spoofed media upload with invalid binary magic bytes',
    method: 'POST',
    path: '/api/messaging/upload-media',
    token: TOKEN_USER_A,
    body: '[multipart payload with spoofed header]',
    expectedStatus: 400,
    description: 'Signature mismatch blocks disguised executable/HTML (400 Bad Request)',
  },
];

function printDryRun() {
  console.log('===============================================================================');
  console.log(' COCPIT CHAT SECURITY: 16 MANUAL VERIFICATION TEST DEFINITIONS');
  console.log(' Base URL:', BASE_URL);
  console.log('===============================================================================\n');

  TESTS.forEach((t, index) => {
    const num = String(index + 1).padStart(2, '0');
    console.log(`[TEST ${num}] [${t.vuln}] ${t.title}`);
    console.log(`  Description   : ${t.description}`);
    console.log(`  Endpoint      : ${t.method} ${BASE_URL}${t.path}`);
    console.log(`  Expected Status: ${t.expectedStatus}`);
    if (t.body) {
      console.log(`  Payload       : ${JSON.stringify(t.body)}`);
    }
    console.log(`  cURL Command  :`);
    let curlCmd = `  curl -s -i -X ${t.method} "${BASE_URL}${t.path}" \\\n    -H "Authorization: ${t.token.slice(0, 15)}..."`;
    if (t.body && typeof t.body === 'object') {
      curlCmd += ` \\\n    -H "Content-Type: application/json" \\\n    -d '${JSON.stringify(t.body)}'`;
    }
    console.log(curlCmd);
    console.log(
      '-------------------------------------------------------------------------------\n'
    );
  });

  console.log('💡 Tip: To run these live against your server, execute:');
  console.log(
    '   BASE_URL=http://localhost:5000 node scripts/manual_chat_security_test.js --run\n'
  );
}

async function runLiveTests() {
  console.log('===============================================================================');
  console.log(' EXECUTING LIVE CHAT SECURITY TESTS AGAINST:', BASE_URL);
  console.log('===============================================================================\n');

  let passed = 0;
  let failed = 0;

  for (let i = 0; i < TESTS.length; i++) {
    const t = TESTS[i];
    const num = String(i + 1).padStart(2, '0');
    const url = `${BASE_URL}${t.path}`;

    // Special handling for upload test
    if (t.id === 'TEST-16') {
      console.log(`[TEST ${num}] ${t.title} [${t.vuln}]`);
      console.log(
        `  ℹ️ Multipart upload test: verified by Jest unit test (upload.security.test.js)`
      );
      console.log(
        `  Expected: ${t.expectedStatus} -> SKIPPED in HTTP fetch mode (use curl with multipart)\n`
      );
      continue;
    }

    const headers = {
      Authorization: t.token,
      Accept: 'application/json',
    };
    const options = {
      method: t.method,
      headers: headers,
    };

    if (t.body && typeof t.body === 'object') {
      headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(t.body);
    }

    const start = Date.now();
    try {
      const res = await fetch(url, options);
      const duration = Date.now() - start;
      const statusMatch = res.status === t.expectedStatus;

      if (statusMatch) {
        passed++;
        console.log(`✅ [PASS] [TEST ${num}] ${t.title} (${duration}ms)`);
        console.log(`   Status: ${res.status} (Matches expected ${t.expectedStatus})\n`);
      } else {
        failed++;
        console.log(`❌ [FAIL] [TEST ${num}] ${t.title} (${duration}ms)`);
        console.log(`   Status: Received ${res.status}, Expected ${t.expectedStatus}\n`);
      }
    } catch (err) {
      failed++;
      console.log(`⚠️ [ERROR] [TEST ${num}] ${t.title}: Could not connect to ${url}`);
      console.log(`   Reason: ${err.message}\n`);
    }
  }

  console.log('===============================================================================');
  console.log(
    ` SUMMARY: ${passed} Passed, ${failed} Failed out of ${TESTS.length - 1} Executed Tests`
  );
  console.log('===============================================================================\n');
}

const arg = process.argv[2] || '--dry-run';
if (arg === '--run') {
  runLiveTests();
} else {
  printDryRun();
}
