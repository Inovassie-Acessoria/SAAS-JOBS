/**
 * Classifier Service
 * Classifica o tipo de recrutador (Advogado / Agência vs Fazenda Direta) e seleciona a categoria de currículo ideal
 */

function classifyJobContact(job) {
  const employerEmail = (job.employer_email || '').toLowerCase();
  const attorneyEmail = (job.attorney_email || '').toLowerCase();
  const attorneyName = (job.attorney_name || '').trim();
  const employerName = (job.employer_name || '').toLowerCase();

  const isAttorneyOrAgent = 
    Boolean(attorneyEmail) || 
    Boolean(attorneyName) ||
    employerEmail.includes('law') ||
    employerEmail.includes('legal') ||
    employerEmail.includes('attorney') ||
    employerEmail.includes('agent') ||
    employerEmail.includes('compliance') ||
    employerEmail.includes('solutions') ||
    employerName.includes('legal') ||
    employerName.includes('law') ||
    employerName.includes('associates') ||
    employerName.includes('h-2a agency') ||
    employerName.includes('staffing');

  const contactType = isAttorneyOrAgent ? 'ATTORNEY' : 'DIRECT_EMPLOYER';
  const targetEmail = attorneyEmail || employerEmail;
  const targetName = attorneyName || job.employer_name;

  return {
    contactType,
    targetEmail,
    targetName,
    preferredTone: isAttorneyOrAgent ? 'FORMAL_COMPLIANCE' : 'PRACTICAL_OPERATIONAL'
  };
}

function determineResumeCategory(job) {
  const text = `${job.job_title} ${job.duties_description} ${job.special_requirements}`.toLowerCase();

  if (text.includes('truck') || text.includes('driver') || text.includes('hauler') || text.includes('cdl') || text.includes('semi-truck') || text.includes('grain cart') || text.includes('transport') || text.includes('driving')) {
    return 'Heavy Truck Driver & Hauling';
  } else if (text.includes('tractor') || text.includes('combine') || text.includes('machinery') || text.includes('operator') || text.includes('equipment') || text.includes('harvest header') || text.includes('loader')) {
    return 'Tractor & Heavy Machinery';
  } else if (text.includes('cattle') || text.includes('livestock') || text.includes('ranch') || text.includes('cow') || text.includes('dairy') || text.includes('feedlot')) {
    return 'Livestock & Cattle';
  } else if (text.includes('landscape') || text.includes('grounds') || text.includes('mower') || text.includes('nursery') || text.includes('turf')) {
    return 'Landscaping & Grounds';
  } else if (text.includes('construction') || text.includes('framing') || text.includes('concrete') || text.includes('carpentry')) {
    return 'General Construction';
  } else {
    return 'General Farm Labor & Harvest';
  }
}

module.exports = {
  classifyJobContact,
  determineResumeCategory
};
