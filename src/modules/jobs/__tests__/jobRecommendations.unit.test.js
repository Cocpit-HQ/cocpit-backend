'use strict';

const {
  CATEGORY_KEYS,
  VALID_CATEGORIES,
  MIN_MATCH_THRESHOLD,
  encodeCursor,
  decodeCursor,
  calculateMergedExperienceYears,
  calculateTitleSimilarity,
  calculateExpScore,
  calculateLocModeScore,
  calculateSalaryScore,
  calculateSkillsScore,
  calculateCompositeMatchScore,
  buildCommonEligibilityPredicate,
} = require('../jobRecommendations.service');

describe('Job Recommendations Unit Tests', () => {

  describe('Category Whitelist & Constants', () => {
    test('should define exactly 4 valid explore categories', () => {
      expect(VALID_CATEGORIES).toEqual([
        'featured',
        'best-matches',
        'from-network',
        'recently-viewed',
      ]);
    });

    test('should export MIN_MATCH_THRESHOLD equal to 60', () => {
      expect(MIN_MATCH_THRESHOLD).toBe(60);
    });
  });

  describe('Cursor Serialization & Deserialization', () => {
    test('should serialize and deserialize cursor cleanly', () => {
      const payload = { score: 85, saves: 4, created_at: '2026-11-01T10:00:00Z', id: 'job-123' };
      const encoded = encodeCursor(payload);
      expect(typeof encoded).toBe('string');
      const decoded = decodeCursor(encoded);
      expect(decoded).toEqual(payload);
    });

    test('should return null for malformed or empty cursors', () => {
      expect(decodeCursor(null)).toBeNull();
      expect(decodeCursor('')).toBeNull();
      expect(decodeCursor('not-valid-base64-json!')).toBeNull();
    });
  });

  describe('Merged Experience Years Interval Calculation', () => {
    test('should return 0 when experiences array is empty or invalid', () => {
      expect(calculateMergedExperienceYears([])).toBe(0);
      expect(calculateMergedExperienceYears(null)).toBe(0);
    });

    test('should calculate single experience duration in years', () => {
      const exp = [
        { start_date: '2022-01-01', end_date: '2024-01-01' }
      ];
      const years = calculateMergedExperienceYears(exp);
      expect(years).toBeCloseTo(2.0, 1);
    });

    test('should merge overlapping experience dates without double counting', () => {
      const exp = [
        { start_date: '2020-01-01', end_date: '2022-01-01' }, // 2 yrs
        { start_date: '2021-01-01', end_date: '2023-01-01' }, // overlapping 2021-2022, extends to 2023
      ];
      // Total merged span: 2020-01-01 to 2023-01-01 = 3 years
      const years = calculateMergedExperienceYears(exp);
      expect(years).toBeCloseTo(3.0, 1);
    });

    test('should sum non-overlapping disjoint experience periods', () => {
      const exp = [
        { start_date: '2020-01-01', end_date: '2021-01-01' }, // 1 yr
        { start_date: '2022-01-01', end_date: '2023-01-01' }, // 1 yr
      ];
      const years = calculateMergedExperienceYears(exp);
      expect(years).toBeCloseTo(2.0, 1);
    });
  });

  describe('Title & Role Similarity ($S_{title}$)', () => {
    test('should return baseline 35 when candidate has no title', () => {
      expect(calculateTitleSimilarity('', 'Senior Backend Engineer')).toBe(35);
      expect(calculateTitleSimilarity(null, 'Product Designer')).toBe(35);
    });

    test('should return 100 for exact title match or substring match', () => {
      expect(calculateTitleSimilarity('Backend Developer', 'Backend Developer')).toBe(100);
      expect(calculateTitleSimilarity('React Developer', 'Senior React Developer')).toBe(100);
    });

    test('should filter stop words and compute token Jaccard similarity', () => {
      // "Senior Full-Stack Engineer" vs "Staff Full-Stack Developer"
      // Stop words: Senior, Staff, Engineer, Developer
      // Tokens: ['full-stack'] and ['full-stack'] -> intersection = 1, union = 1 -> 100
      const score = calculateTitleSimilarity('Senior Full-Stack Engineer', 'Staff Full-Stack Developer');
      expect(score).toBe(100);
    });
  });

  describe('Experience Score ($S_{exp}$)', () => {
    test('should return 70 when job has no experience requirements', () => {
      expect(calculateExpScore(3, null, null)).toBe(70);
    });

    test('should score entry-level candidates appropriately', () => {
      expect(calculateExpScore(0, 0, 1)).toBe(65);
      expect(calculateExpScore(0, 3, 5)).toBe(30);
    });

    test('should return 100 when candidate experience is within bounds', () => {
      expect(calculateExpScore(3, 2, 5)).toBe(100);
    });

    test('should penalize slightly overqualified candidate (85) and heavily overqualified (65)', () => {
      expect(calculateExpScore(4, 1, 2)).toBe(85); // within 2 yrs
      expect(calculateExpScore(8, 1, 2)).toBe(65); // > 2 yrs over
    });

    test('should penalize slightly underqualified (40) and heavily underqualified (20)', () => {
      expect(calculateExpScore(2.5, 3, 5)).toBe(40); // within 1 yr
      expect(calculateExpScore(1, 4, 6)).toBe(20);   // > 1 yr under
    });
  });

  describe('Location & Work Mode Score ($S_{loc_mode}$)', () => {
    test('Remote candidate seeking remote job scores 100', () => {
      expect(calculateLocModeScore('Remote', 'San Francisco', 'Remote', 'Anywhere')).toBe(100);
    });

    test('Candidate prefers Onsite, job is Remote -> mode penalty', () => {
      // modeScore = 40, locScore = 100 (remote job) -> 0.5(40) + 0.5(100) = 70
      expect(calculateLocModeScore('Onsite', 'Austin, TX', 'Remote', 'Anywhere')).toBe(70);
    });

    test('Candidate prefers Hybrid, job is Onsite in same city', () => {
      // modeScore = 70, locScore = 100 -> 0.5(70) + 0.5(100) = 85
      expect(calculateLocModeScore('Hybrid', 'Seattle, WA', 'Onsite', 'Seattle, WA')).toBe(85);
    });

    test('Candidate location mismatch on onsite job', () => {
      // modeScore = 100, locScore = 20 -> 0.5(100) + 0.5(20) = 60
      expect(calculateLocModeScore('Onsite', 'Chicago, IL', 'Onsite', 'New York, NY')).toBe(60);
    });
  });

  describe('Salary Alignment Score ($S_{salary}$)', () => {
    test('returns neutral 50 when candidate or job salary is unstated', () => {
      expect(calculateSalaryScore(null, null, 100000, 150000, 'YEARLY')).toBe(50);
      expect(calculateSalaryScore(120000, 160000, null, null, 'YEARLY')).toBe(50);
    });

    test('returns 100 for overlapping ranges', () => {
      expect(calculateSalaryScore(100000, 140000, 120000, 160000, 'YEARLY')).toBe(100);
    });

    test('normalizes hourly and monthly rates to annual', () => {
      // Job: $50/hr -> $104,000/yr. Candidate expectation: $100,000 - $120,000
      expect(calculateSalaryScore(100000, 120000, 50, 60, 'HOURLY')).toBe(100);
    });

    test('returns 70 when within 20% boundary', () => {
      // Candidate: $100,000. Job: $85,000 (within 20% of 100k)
      expect(calculateSalaryScore(100000, 120000, 85000, 95000, 'YEARLY')).toBe(70);
    });

    test('returns 30 for complete mismatch', () => {
      expect(calculateSalaryScore(150000, 180000, 50000, 70000, 'YEARLY')).toBe(30);
    });
  });

  describe('Skills Match Score ($S_{skills}$)', () => {
    test('returns 50 when job specifies no skills', () => {
      expect(calculateSkillsScore(['React', 'Node'], [])).toBe(50);
    });

    test('returns baseline 20 when candidate has no skills', () => {
      expect(calculateSkillsScore([], ['React', 'Node'])).toBe(20);
    });

    test('calculates percentage of job skills matched by candidate', () => {
      const candidateSkills = ['React', 'TypeScript', 'Node.js', 'PostgreSQL'];
      const jobSkills = ['React', 'TypeScript', 'GraphQL', 'AWS'];
      // 2 out of 4 matched = 50%
      expect(calculateSkillsScore(candidateSkills, jobSkills)).toBe(50);
    });
  });

  describe('Composite Match Score Validation Fixtures', () => {
    test('Fixture A: Strong match passes >= 60 threshold', () => {
      const candidate = {
        candidateTitle: 'Backend Engineer',
        candidateSkills: ['Node.js', 'PostgreSQL', 'Redis', 'Docker'],
        candidateYears: 4,
        workPreference: 'Remote',
        location: 'San Francisco, CA',
        minSalary: null,
        maxSalary: null,
      };

      const job = {
        title: 'Backend Engineer',
        skills: ['node.js', 'postgresql', 'redis', 'aws'], // 3 of 4 = 75
        experience_min: 3,
        experience_max: 5, // 100
        work_mode: 'Remote',
        location: 'San Francisco, CA', // 100
        salary_min: null,
        salary_max: null,
      };

      const { score } = { score: calculateCompositeMatchScore(candidate, job) };
      // S_skills: 75 * 0.35 = 26.25
      // S_title: 100 * 0.25 = 25
      // S_exp: 100 * 0.15 = 15
      // S_loc_mode: 100 * 0.15 = 15
      // S_salary: 50 * 0.10 = 5
      // Total = 86.25 -> 86
      expect(score).toBeGreaterThanOrEqual(MIN_MATCH_THRESHOLD);
      expect(score).toBe(86);
    });

    test('Fixture B: Candidate with no skills but strong title & location match passes >= 60', () => {
      const candidate = {
        candidateTitle: 'React Frontend Developer',
        candidateSkills: [],
        candidateYears: 3,
        workPreference: 'Onsite',
        location: 'New York, NY',
        minSalary: null,
        maxSalary: null,
      };

      const job = {
        title: 'React Frontend Developer',
        skills: ['react', 'next.js', 'tailwind'],
        experience_min: 2,
        experience_max: 4,
        work_mode: 'Onsite',
        location: 'New York, NY',
        salary_min: null,
        salary_max: null,
      };

      const score = calculateCompositeMatchScore(candidate, job);
      // S_skills: 20 * 0.35 = 7
      // S_title: 100 * 0.25 = 25
      // S_exp: 100 * 0.15 = 15
      // S_loc_mode: 100 * 0.15 = 15
      // S_salary: 50 * 0.10 = 5
      // Total = 67
      expect(score).toBeGreaterThanOrEqual(MIN_MATCH_THRESHOLD);
      expect(score).toBe(67);
    });

    test('Fixture C: Completely blank profile fails < 60 threshold', () => {
      const candidate = {
        candidateTitle: '',
        candidateSkills: [],
        candidateYears: 0,
        workPreference: null,
        location: null,
        minSalary: null,
        maxSalary: null,
      };

      const job = {
        title: 'Senior DevOps Architect',
        skills: ['kubernetes', 'terraform', 'aws', 'helm'],
        experience_min: 5,
        experience_max: 8,
        work_mode: 'Hybrid',
        location: 'Seattle, WA',
        salary_min: null,
        salary_max: null,
      };

      const score = calculateCompositeMatchScore(candidate, job);
      // S_skills: 20 * 0.35 = 7
      // S_title: 35 * 0.25 = 8.75
      // S_exp: 30 * 0.15 = 4.5
      // S_loc_mode: 55 * 0.15 = 8.25
      // S_salary: 50 * 0.10 = 5
      // Total = 33.5 -> 34
      expect(score).toBeLessThan(MIN_MATCH_THRESHOLD);
      expect(score).toBe(34);
    });
  });

  describe('Common Eligibility Predicate Builder', () => {
    test('builds null-safe predicate for guest users (no userId)', () => {
      const { whereClause, params } = buildCommonEligibilityPredicate(null, 1);
      expect(params).toHaveLength(0);
      expect(whereClause).toContain('j.is_active = TRUE');
      expect(whereClause).toContain("j.status = 'ACTIVE'");
      expect(whereClause).toContain('j.expires_at > NOW()');
      expect(whereClause).not.toContain('NOT EXISTS'); // Candidate exclusions only applied when userId exists
    });

    test('applies all candidate exclusions and block checks for authenticated users', () => {
      const { whereClause, params } = buildCommonEligibilityPredicate('user-uuid-123', 1);
      expect(params).toEqual(['user-uuid-123']);
      expect(whereClause).toContain('j.recruiter_id != $1');
      expect(whereClause).toContain('FROM job_applications ja');
      expect(whereClause).toContain("ja.current_status != 'Withdrawn'");
      expect(whereClause).toContain('FROM job_offers jo');
      expect(whereClause).toContain('FROM blocks b');
    });
  });

});

