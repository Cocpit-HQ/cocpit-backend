'use strict';

const { searchCompanies } = require('../queries/companySearch.query');
const { searchInstitutes } = require('../queries/instituteSearch.query');

describe('Search Actor Context Regression Test Suite', () => {
  let mockClient;

  beforeEach(() => {
    mockClient = {
      query: jest.fn(),
      release: jest.fn(),
    };
  });

  describe('1. Company Search: Organization vs User Actor Context', () => {
    test('When searching as ORGANIZATION, personal employment signals are suppressed and headline is prioritized', async () => {
      mockClient.query.mockResolvedValueOnce({
        rows: [
          {
            id: 'target-company-1',
            name: 'Acme Corp',
            slug: 'acme-corp',
            headline: 'Innovating tomorrow together',
            industry: 'Technology',
            location: 'San Francisco, CA',
            location_formatted: 'San Francisco, CA',
            city: 'San Francisco',
            country: 'USA',
            size: '50-200',
            logo_url: 'https://example.com/logo.png',
            entity_type: 'COMPANY',
            verification_status: 'VERIFIED',
            is_following: false,
            message_permission: 'everyone',
            messages_enabled: true,
            is_self: false,
            viewer_employment_status: 1, // Even if raw data somehow had 1, orgActorId must suppress it
            connections_working_here: 5,
            relevance_score: 150,
          },
        ],
      });

      const result = await searchCompanies(mockClient, {
        searchTerm: 'Acme',
        orgActorId: 'searching-org-123',
      });

      const [executedSql, params] = mockClient.query.mock.calls[0];

      // Verification of generated SQL for ORGANIZATION actor
      expect(executedSql).toContain('c.headline');
      expect(executedSql).toContain('organization_org_follows');
      expect(executedSql).toContain('follower_org_id = $4');
      expect(executedSql).toContain('c.org_id = $4'); // isSelf check matches org ID
      expect(params).toContain('searching-org-123');

      // Verification of formatted output
      expect(result.items).toHaveLength(1);
      const company = result.items[0];
      expect(company.headline).toBe('Innovating tomorrow together');
      expect(company.context_type).toBe('headline');
      expect(company.context_signal).toBe('Innovating tomorrow together');
      expect(company.context_signal).not.toBe('You previously worked here');
      expect(company.context_signal).not.toBe('You work here');
    });

    test('When searching as ORGANIZATION without headline, falls back to Industry • Location', async () => {
      mockClient.query.mockResolvedValueOnce({
        rows: [
          {
            id: 'target-company-2',
            name: 'Beta LLC',
            slug: 'beta-llc',
            headline: null,
            industry: 'Finance',
            location: 'New York, NY',
            city: 'New York',
            country: 'USA',
            size: '10-50',
            logo_url: null,
            entity_type: 'COMPANY',
            verification_status: 'UNVERIFIED',
            is_following: false,
            message_permission: 'everyone',
            messages_enabled: true,
            is_self: false,
            viewer_employment_status: 0,
            connections_working_here: 0,
            relevance_score: 80,
          },
        ],
      });

      const result = await searchCompanies(mockClient, {
        searchTerm: 'Beta',
        orgActorId: 'searching-org-123',
      });

      expect(result.items[0].headline).toBeNull();
      expect(result.items[0].context_type).toBe('industry_location');
      expect(result.items[0].context_signal).toBe('Finance • New York, NY');
    });

    test('When searching as USER, personal employment status is preserved', async () => {
      mockClient.query.mockResolvedValueOnce({
        rows: [
          {
            id: 'target-company-1',
            name: 'Acme Corp',
            slug: 'acme-corp',
            headline: 'Innovating tomorrow together',
            industry: 'Technology',
            location: 'San Francisco, CA',
            size: '50-200',
            logo_url: null,
            entity_type: 'COMPANY',
            verification_status: 'VERIFIED',
            is_following: false,
            message_permission: 'everyone',
            messages_enabled: true,
            is_self: false,
            viewer_employment_status: 1, // Previously worked here
            connections_working_here: 0,
            relevance_score: 150,
          },
        ],
      });

      const result = await searchCompanies(mockClient, {
        searchTerm: 'Acme',
        viewerId: 'user-uuid-456',
      });

      const [executedSql, params] = mockClient.query.mock.calls[0];
      expect(executedSql).toContain('viewer_conns AS');
      expect(executedSql).toContain('organization_followers');
      expect(executedSql).toContain('HAVING COUNT(*) > 0');
      expect(params).toContain('user-uuid-456');

      expect(result.items[0].context_type).toBe('employment');
      expect(result.items[0].context_signal).toBe('You previously worked here');
    });

    test('When actively_hiring filter is enabled, query includes jobs EXISTS clause and freshness ranking boost', async () => {
      mockClient.query.mockResolvedValueOnce({
        rows: [
          {
            id: 'hiring-company-1',
            name: 'Google',
            slug: 'google',
            headline: 'Search and Cloud',
            industry: 'Technology',
            location: 'Mountain View, CA',
            size: '10000+',
            logo_url: null,
            entity_type: 'COMPANY',
            verification_status: 'VERIFIED',
            is_following: false,
            message_permission: 'everyone',
            messages_enabled: true,
            is_self: false,
            viewer_employment_status: 0,
            connections_working_here: 0,
            relevance_score: 180,
          },
        ],
      });

      const result = await searchCompanies(mockClient, {
        searchTerm: 'Google',
        queryParams: { actively_hiring: 'true' },
      });

      const [executedSql] = mockClient.query.mock.calls[0];

      // Verifies actively hiring filter clause
      expect(executedSql).toContain('FROM jobs j');
      expect(executedSql).toContain('j.org_id = c.org_id');
      expect(executedSql).toContain("j.status = 'ACTIVE' OR j.is_active = TRUE");
      expect(executedSql).toContain("j.actively_hiring = TRUE OR j.created_at >= NOW() - INTERVAL '30 days'");

      // Verifies freshness and volume boosts in scoring
      expect(executedSql).toContain('hiring_freshness_boost');
      expect(executedSql).toContain('hiring_volume_boost');

      expect(result.items).toHaveLength(1);
      expect(result.items[0].name).toBe('Google');
    });

    test('When actively_hiring is not specified, hiring filter clause is not injected', async () => {
      mockClient.query.mockResolvedValueOnce({
        rows: [],
      });

      await searchCompanies(mockClient, {
        searchTerm: 'Google',
      });

      const [executedSql] = mockClient.query.mock.calls[0];
      expect(executedSql).not.toContain("j.actively_hiring = TRUE OR j.created_at >= NOW() - INTERVAL '30 days'");
    });
  });

  describe('2. Institute Search: Organization vs User Actor Context', () => {
    test('When searching as ORGANIZATION, personal education signals are suppressed and headline is prioritized', async () => {
      mockClient.query.mockResolvedValueOnce({
        rows: [
          {
            id: 'target-institute-1',
            name: 'Stanford University',
            slug: 'stanford',
            headline: 'The wind of freedom blows',
            institution_type: 'University',
            campus_location: 'Stanford, CA',
            location: 'Stanford, CA',
            size: '10000+',
            logo_url: null,
            entity_type: 'INSTITUTION',
            verification_status: 'VERIFIED',
            verified_edu: true,
            is_following: false,
            message_permission: 'everyone',
            messages_enabled: true,
            is_self: false,
            viewer_studied_here: true,
            alumni_in_network: 12,
            relevance_score: 200,
          },
        ],
      });

      const result = await searchInstitutes(mockClient, {
        searchTerm: 'Stanford',
        orgActorId: 'searching-org-123',
      });

      const [executedSql, params] = mockClient.query.mock.calls[0];
      expect(executedSql).toContain('c.headline');
      expect(executedSql).toContain('organization_org_follows');
      expect(params).toContain('searching-org-123');

      expect(result.items[0].headline).toBe('The wind of freedom blows');
      expect(result.items[0].context_type).toBe('headline');
      expect(result.items[0].context_signal).toBe('The wind of freedom blows');
      expect(result.items[0].context_signal).not.toBe('You studied here');
    });
  });
});

