'use strict';

const { buildJobFilters } = require('../../../core/utils/jobQueryBuilder');

describe('Job Publishing Timing Regression Tests', () => {

  describe('1. Date Posted Filter with published_at fallback', () => {
    test('TC-01: datePosted="today" uses COALESCE(j.published_at, j.created_at)', () => {
      const { conditions, values } = buildJobFilters({ datePosted: 'today' }, 1);
      
      expect(conditions).toHaveLength(1);
      expect(conditions[0]).toBe('COALESCE(j.published_at, j.created_at) >= $1');
      expect(values).toHaveLength(1);
      expect(values[0]).toBeInstanceOf(Date);
    });

    test('TC-02: datePosted="past week" uses COALESCE(j.published_at, j.created_at)', () => {
      const { conditions, values } = buildJobFilters({ datePosted: 'past week' }, 1);
      
      expect(conditions).toHaveLength(1);
      expect(conditions[0]).toBe('COALESCE(j.published_at, j.created_at) >= $1');
      expect(values).toHaveLength(1);
      expect(values[0]).toBeInstanceOf(Date);
    });

    test('TC-03: datePosted="last 30 days" uses COALESCE(j.published_at, j.created_at)', () => {
      const { conditions, values } = buildJobFilters({ datePosted: 'last 30 days' }, 1);
      
      expect(conditions).toHaveLength(1);
      expect(conditions[0]).toBe('COALESCE(j.published_at, j.created_at) >= $1');
      expect(values).toHaveLength(1);
      expect(values[0]).toBeInstanceOf(Date);
    });
  });

  describe('2. Controller SQL and Query Verifications', () => {
    test('TC-04: getAllJobs SQL orders by COALESCE(j.published_at, j.created_at) DESC', () => {
      const fs = require('fs');
      const path = require('path');
      const jobControllerSource = fs.readFileSync(
        path.resolve(__dirname, '../job.controller.js'),
        'utf8'
      );

      // Verify getAllJobs query uses COALESCE
      expect(jobControllerSource).toContain('ORDER BY COALESCE(j.published_at, j.created_at) DESC');
      // Verify submitJob sets published_at = NOW()
      expect(jobControllerSource).toContain('"published_at = NOW()"');
      // Verify cursor pagination uses COALESCE
      expect(jobControllerSource).toContain('COALESCE(j.published_at, j.created_at) < $${paramCount}');
    });

    test('TC-05: organization.jobs.controller uses published_at on publishing and ordering', () => {
      const fs = require('fs');
      const path = require('path');
      const orgJobsSource = fs.readFileSync(
        path.resolve(__dirname, '../../organization/organization.jobs.controller.js'),
        'utf8'
      );

      // Verify ordering
      expect(orgJobsSource).toContain('ORDER BY COALESCE(j.published_at, j.created_at) DESC');
      // Verify updateJob updates published_at when publishing
      expect(orgJobsSource).toContain('published_at = CASE');
      expect(orgJobsSource).toContain('created_at = CASE');
      expect(orgJobsSource).toContain('isPublishing');
    });

    test('TC-06: jobRecommendationsService scores freshness using COALESCE(j.published_at, j.created_at)', () => {
      const fs = require('fs');
      const path = require('path');
      const recSource = fs.readFileSync(
        path.resolve(__dirname, '../jobRecommendations.service.js'),
        'utf8'
      );

      expect(recSource).toContain('COALESCE(j.published_at, j.created_at) >= NOW() - INTERVAL \'24 HOURS\'');
      expect(recSource).toContain('posted_at: getRelativeTime(row.published_at || row.created_at)');
    });
  });
});

