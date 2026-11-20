const { buildJobFilters } = require('../../../core/utils/jobQueryBuilder');

describe('SCRUM-8 / SCRUM-1849: Job Salary Filter & Undisclosed Salary Exclusion Regression Tests', () => {
  const DISCLOSED_GUARD = "(j.salary_visibility IS NULL OR j.salary_visibility != 'PRIVATE') AND (COALESCE(j.salary_min, 0) > 0 OR COALESCE(j.salary_max, 0) > 0)";

  describe('1. Custom Salary Range Parsing', () => {
    test('TC-01: Custom:min-max correctly generates range clause and requires disclosed salary', () => {
      const { conditions, values } = buildJobFilters({ salary_range: 'Custom:500000-1000000' }, 1);
      
      const salaryCondition = conditions.find(c => c.includes('salary_min') || c.includes('salary_max'));
      expect(salaryCondition).toBeDefined();
      expect(salaryCondition).toContain(DISCLOSED_GUARD);
      expect(salaryCondition).toContain('COALESCE(j.salary_max, j.salary_min) >= $1');
      expect(salaryCondition).toContain('COALESCE(j.salary_min, j.salary_max) <= $2');
      expect(values).toEqual([500000, 1000000]);
    });

    test('TC-02: Custom:min-0 (minimum only) generates lower-bound clause and requires disclosed salary', () => {
      const { conditions, values } = buildJobFilters({ salary_range: 'Custom:600000-0' }, 1);

      const salaryCondition = conditions.find(c => c.includes('salary_min') || c.includes('salary_max'));
      expect(salaryCondition).toBeDefined();
      expect(salaryCondition).toContain(DISCLOSED_GUARD);
      expect(salaryCondition).toContain('COALESCE(j.salary_max, j.salary_min) >= $1');
      expect(values).toEqual([600000]);
    });

    test('TC-03: Custom:0-max (maximum only) generates upper-bound clause with positive check and requires disclosed salary', () => {
      const { conditions, values } = buildJobFilters({ salary_range: 'Custom:0-400000' }, 1);

      const salaryCondition = conditions.find(c => c.includes('salary_min') || c.includes('salary_max'));
      expect(salaryCondition).toBeDefined();
      expect(salaryCondition).toContain(DISCLOSED_GUARD);
      expect(salaryCondition).toContain('COALESCE(j.salary_min, j.salary_max) <= $1');
      expect(salaryCondition).toContain('COALESCE(j.salary_min, j.salary_max) > 0');
      expect(values).toEqual([400000]);
    });

    test('TC-04: Custom:min-max with inverted bounds auto-swaps bounds gracefully', () => {
      const { conditions, values } = buildJobFilters({ salary_range: 'Custom:800000-300000' }, 1);

      const salaryCondition = conditions.find(c => c.includes('salary_min') || c.includes('salary_max'));
      expect(salaryCondition).toBeDefined();
      expect(values).toEqual([300000, 800000]);
    });

    test('TC-05: Custom:0-0 without bounds produces no salary restriction', () => {
      const { conditions, values } = buildJobFilters({ salary_range: 'Custom:0-0' }, 1);

      const salaryCondition = conditions.find(c => c.includes('salary_min') || c.includes('salary_max'));
      expect(salaryCondition).toBeUndefined();
      expect(values).toHaveLength(0);
    });
  });

  describe('2. Predefined Salary Ranges', () => {
    test('TC-06: "Under 3L" generates upper bound and enforces disclosed salary (> 0 and not private)', () => {
      const { conditions, values } = buildJobFilters({ salaryRanges: 'Under 3L' }, 1);

      const salaryCondition = conditions.find(c => c.includes('salary_min') || c.includes('salary_max'));
      expect(salaryCondition).toBeDefined();
      expect(salaryCondition).toContain(DISCLOSED_GUARD);
      expect(salaryCondition).toContain('COALESCE(j.salary_min, j.salary_max) <= $1');
      expect(salaryCondition).toContain('COALESCE(j.salary_min, j.salary_max) > 0');
      expect(values).toEqual([300000]);
    });

    test('TC-07: "3L-5L" generates range clause with disclosed salary guard', () => {
      const { conditions, values } = buildJobFilters({ salaryRanges: '3L-5L' }, 1);

      const salaryCondition = conditions.find(c => c.includes('salary_min') || c.includes('salary_max'));
      expect(salaryCondition).toBeDefined();
      expect(salaryCondition).toContain(DISCLOSED_GUARD);
      expect(values).toEqual([300000, 500000]);
    });

    test('TC-08: "10L+" generates lower bound with disclosed salary guard', () => {
      const { conditions, values } = buildJobFilters({ salaryRanges: '10L+' }, 1);

      const salaryCondition = conditions.find(c => c.includes('salary_min') || c.includes('salary_max'));
      expect(salaryCondition).toBeDefined();
      expect(salaryCondition).toContain(DISCLOSED_GUARD);
      expect(values).toEqual([1000000]);
    });
  });

  describe('3. Multi-Select Salary Ranges (OR logic)', () => {
    test('TC-09: Multiple ranges combine with OR under the shared disclosed guard', () => {
      const { conditions, values } = buildJobFilters({ salaryRanges: ['Under 3L', 'Custom:600000-1000000'] }, 1);

      const salaryCondition = conditions.find(c => c.includes('salary_min') || c.includes('salary_max'));
      expect(salaryCondition).toBeDefined();
      expect(salaryCondition).toContain(DISCLOSED_GUARD);
      expect(salaryCondition).toContain(' OR ');
      expect(values).toEqual([300000, 600000, 1000000]);
    });
  });

  describe('4. Direct Numeric Salary Parameters (min_salary / max_salary)', () => {
    test('TC-10: Standalone min_salary and max_salary generate range with disclosed salary guard', () => {
      const { conditions, values } = buildJobFilters({ min_salary: 400000, max_salary: 800000 }, 1);

      const salaryCondition = conditions.find(c => c.includes('salary_min') || c.includes('salary_max'));
      expect(salaryCondition).toBeDefined();
      expect(salaryCondition).toContain(DISCLOSED_GUARD);
      expect(values).toEqual([400000, 800000]);
    });
  });

  describe('5. Unfiltered / Default Behavior', () => {
    test('TC-11: When no salary filter is specified, no salary condition is appended (undisclosed jobs allowed)', () => {
      const { conditions, values } = buildJobFilters({}, 1);

      const salaryCondition = conditions.find(c => c.includes('salary_min') || c.includes('salary_max'));
      expect(salaryCondition).toBeUndefined();
      expect(values).toHaveLength(0);
    });
  });
});
