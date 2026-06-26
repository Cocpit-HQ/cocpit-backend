const compareExperience = (actualExp, minExp, maxExp, label) => {
  let actualYears = 0;

  if (typeof actualExp === 'number') {
    actualYears = actualExp;
  } else if (typeof actualExp === 'string') {
    const match = actualExp.match(/(\d+(\.\d+)?)/);
    if (match) {
      actualYears = parseFloat(match[1]);
    }
  }

  // Fallback to label parsing if minExp and maxExp are missing
  if (minExp == null && maxExp == null && label) {
    if (label.includes('Fresher')) {
      minExp = 0; maxExp = 2;
    } else if (label.includes('Junior (1-3 yrs)')) {
      minExp = 1; maxExp = 3;
    } else if (label.includes('Mid-level (3-5 yrs)')) {
      minExp = 3; maxExp = 5;
    } else if (label.includes('Senior (5+ yrs)')) {
      minExp = 5; maxExp = null;
    }
  }

  // Format Required Range
  let requiredString = 'Not specified';
  if (minExp != null && maxExp != null && minExp !== maxExp && maxExp > 0) {
    requiredString = `${minExp}-${maxExp} Yrs`;
  } else if (minExp != null) {
    requiredString = `${minExp}+ Yrs`;
  } else if (maxExp != null) {
    requiredString = `Up to ${maxExp} Yrs`;
  } else if (label) {
    requiredString = label;
  }

  // Calculate status
  let status = 'UNKNOWN';
  let summary = 'Experience requirement is not clearly defined.';

  if (minExp != null || maxExp != null) {
    const effectiveMin = minExp || 0;
    const effectiveMax = maxExp || 99; // effectively infinity

    if (actualYears > effectiveMax && effectiveMax < 99) {
      status = 'EXCEEDS';
      summary = 'Exceeds the maximum experience requirement for this role.';
    } else if (actualYears >= effectiveMin && (actualYears <= effectiveMax || effectiveMax === 99)) {
      status = 'MATCHES';
      summary = 'Directly matches the required experience for this role.';
      if (actualYears > effectiveMax && effectiveMax === 99) {
        status = 'EXCEEDS';
        summary = 'Exceeds the minimum experience requirement for this role.';
      }
    } else {
      status = 'BELOW';
      summary = 'Does not meet the minimum experience requirement for this role.';
    }
  }

  return {
    required: requiredString,
    actual: `${actualYears} Yrs`,
    status,
    summary,
  };
};

const getLatestEducation = (educationArray) => {
  if (!educationArray || educationArray.length === 0) {
    return { degree: 'Not specified', class: '', summary: 'No education details provided.' };
  }

  const latest = educationArray[0];
  const degreeStr = latest.degree || latest.title || latest.course || 'Degree';
  const schoolStr = latest.school || latest.institute || latest.university || 'University';
  
  const formattedDegree = `${degreeStr} from ${schoolStr}`;
  
  let classStr = '';
  if (latest.endDate) {
    const year = new Date(latest.endDate).getFullYear();
    if (!isNaN(year)) {
      classStr = `CLASS OF ${year}`;
    } else if (typeof latest.endDate === 'string' && latest.endDate.length === 4) {
      classStr = `CLASS OF ${latest.endDate}`;
    } else {
      classStr = `ENDED ${latest.endDate}`;
    }
  } else if (latest.year) {
    classStr = `CLASS OF ${latest.year}`;
  }

  return {
    degree: formattedDegree,
    class: classStr,
    summary: 'Candidate education details provided.',
  };
};

module.exports = {
  compareExperience,
  getLatestEducation
};
