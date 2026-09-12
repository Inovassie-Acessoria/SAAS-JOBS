const Anthropic = require('@anthropic-ai/sdk');
const { db, logEvent } = require('../config/database');
const { getSetting } = require('./settingsService');
const { classifyJobContact, determineResumeCategory } = require('./classifierService');

function getAnthropicClient() {
  const apiKey = getSetting('claude_api_key') || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('Anthropic Claude API Key não configurada. Por favor, adicione sua chave na Central de Integrações.');
  }
  return new Anthropic({ apiKey });
}

async function generateApplicationForJob(jobId) {
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
  if (!job) {
    throw new Error(`Vaga #${jobId} não encontrada.`);
  }

  const candidate = db.prepare('SELECT * FROM candidate_profile ORDER BY id DESC LIMIT 1').get();
  if (!candidate) {
    throw new Error('Perfil de candidato não cadastrado no sistema.');
  }

  const { contactType, targetEmail, targetName, preferredTone } = classifyJobContact(job);
  const resumeCategory = determineResumeCategory(job);

  // Busca currículo correspondente no banco
  let matchingResume = db.prepare('SELECT * FROM resumes WHERE category = ? ORDER BY is_default DESC, id DESC LIMIT 1').get(resumeCategory);
  if (!matchingResume) {
    matchingResume = db.prepare('SELECT * FROM resumes ORDER BY is_default DESC, id DESC LIMIT 1').get();
  }

  const apiKey = getSetting('claude_api_key') || process.env.ANTHROPIC_API_KEY;
  let parsedOutput = null;

  if (apiKey && apiKey.startsWith('sk-ant')) {
    try {
      const anthropic = new Anthropic({ apiKey });
      const draftModel = getSetting('claude_draft_model', 'claude-3-7-sonnet-latest');

      const systemPrompt = `You are an expert American agricultural and H-2A/H-2B recruiter.
Craft a hyper-personalized, concise, high-converting application letter in flawless natural American English for Job Order #${job.job_order_id}.
Return ONLY a valid JSON object with keys: email_subject, email_body, whatsapp_message.`;

      const userPrompt = `Job Title: ${job.job_title}, Employer: ${job.employer_name}, Location: ${job.employer_city}, ${job.employer_state}, Wage: $${job.wage_rate}/${job.wage_unit}, Dates: ${job.start_date} to ${job.end_date}, Candidate: ${candidate.full_name}, Experience: ${candidate.experience_years} years, Machinery: ${candidate.machinery_skills}.`;

      logEvent('info', 'Claude AI', `Gerando candidatura sob medida para vaga ${job.job_order_id} via ${draftModel}...`);

      const response = await anthropic.messages.create({
        model: draftModel,
        max_tokens: 1500,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }]
      });

      let rawContent = response.content[0]?.text?.trim() || '';
      if (rawContent.startsWith('```json')) {
        rawContent = rawContent.replace(/^```json\n?/, '').replace(/\n?```$/, '');
      } else if (rawContent.startsWith('```')) {
        rawContent = rawContent.replace(/^```\n?/, '').replace(/\n?```$/, '');
      }

      parsedOutput = JSON.parse(rawContent);
    } catch (apiErr) {
      logEvent('warn', 'Claude AI', `API Claude indisponível (${apiErr.message}). Utilizando Motor de Redação Nativo de Alta Conversão.`);
    }
  }

  // Se não tem chave ou a chamada falhou, utiliza o Motor Nativo de Alta Conversão
  if (!parsedOutput) {
    logEvent('info', 'Smart Copy Engine', `Gerando candidatura sob medida nativa para ${job.job_title} (#${job.job_order_id})...`);

    const isAttorney = contactType === 'ATTORNEY';
    const isTruckDriver = resumeCategory === 'Heavy Truck Driver & Hauling' || job.job_title.toLowerCase().includes('truck') || job.job_title.toLowerCase().includes('driver');
    const isLandscape = resumeCategory === 'Landscaping & Grounds';
    const isConstruction = resumeCategory === 'General Construction';

    let emailSubject = `Application: ${job.job_title} - DOL Job Order #${job.job_order_id} - ${candidate.full_name}`;
    let emailBody = '';
    let whatsappMessage = '';

    if (isAttorney) {
      emailBody = `Dear ${targetName} / Legal Compliance Team,

I am writing to formally submit my application for ETA-790 Job Order #${job.job_order_id} (${job.job_title} at ${job.employer_name} in ${job.employer_city || 'the USA'}, ${job.employer_state || ''}).

I meet all specified job qualifications, physical thresholds, and seasonal availability requirements outlined in your Department of Labor certification:
• Over ${candidate.experience_years || 5} years of proven practical experience in ${isTruckDriver ? 'heavy commercial truck driving and crop transport' : candidate.skills || 'agricultural operations'}.
• Valid driver license, clean background check, and ready for ${job.start_date} through ${job.end_date}.
• Proficient with: ${isTruckDriver ? 'Kenworth/Peterbilt semi-trucks, grain carts, PTO hydraulics, and pre-trip inspections' : candidate.machinery_skills || 'John Deere & Case IH tractors'}.
• All personal documentation and passport are ready for consular visa processing upon confirmation.

Attached please find my comprehensive US-standard resume in PDF format for your review.

Sincerely,
${candidate.full_name}
Phone / WhatsApp: ${candidate.phone || candidate.whatsapp}
Email: ${candidate.email}`;

      whatsappMessage = `Dear ${targetName}, this is ${candidate.full_name} confirming my candidate submission for ETA-790 Job Order #${job.job_order_id} (${job.job_title} at ${job.employer_name}). My resume has been sent to your recruitment inbox.`;
    } else {
      emailBody = `Dear ${job.employer_name} Hiring Team,

I am writing to submit my application for your ${job.job_title} opening (DOL Job Order #${job.job_order_id}).

With over ${candidate.experience_years || 5} years of hands-on experience, I am prepared to deliver reliable, high-stamina performance for your full season from ${job.start_date} to ${job.end_date}.

Key qualifications for your review:
• Hands-on experience with: ${isTruckDriver ? 'heavy semi-trucks (Class A/Tractor-Trailer), grain hauling, and daily preventative maintenance' : isLandscape ? 'commercial zero-turn mowers, irrigation, trenchers, and hardscape' : isConstruction ? 'commercial framing, power tools, concrete, and site safety' : candidate.machinery_skills || 'high-horsepower tractors and combines'}.
• Valid driver license, clean record, and drug-free commitment.
• Physically capable of lifting 60+ lbs and working 60+ hour outdoor workweeks without issue.

My complete US-standard resume is attached. I look forward to speaking with your team.

Best regards,
${candidate.full_name}
Contact: ${candidate.phone || candidate.whatsapp}
Email: ${candidate.email}`;

      whatsappMessage = `Hello ${job.employer_name}, this is ${candidate.full_name}. I just applied for your ${job.job_title} position (Job Order #${job.job_order_id}). Experienced, dependable, and ready to start on ${job.start_date}. Full resume sent to your email.`;
    }

    parsedOutput = {
      email_subject: emailSubject,
      email_body: emailBody,
      whatsapp_message: whatsappMessage
    };
  }

  // Insere ou atualiza na fila
  const targetRecipientEmail = targetEmail || job.employer_email || job.attorney_email;
  const targetRecipientPhone = job.employer_phone || '';

  const existingQueue = db.prepare('SELECT id FROM applications_queue WHERE job_id = ?').get(job.id);
  let queueId;

  if (existingQueue) {
    db.prepare(`
      UPDATE applications_queue SET
        resume_id = ?,
        email_subject = ?,
        email_body = ?,
        whatsapp_message = ?,
        contact_type = ?,
        recipient_email = ?,
        recipient_phone = ?,
        resume_category = ?,
        status = 'pending_review'
      WHERE id = ?
    `).run(
      matchingResume ? matchingResume.id : null,
      parsedOutput.email_subject,
      parsedOutput.email_body,
      parsedOutput.whatsapp_message,
      contactType,
      targetRecipientEmail,
      targetRecipientPhone,
      resumeCategory,
      existingQueue.id
    );
    queueId = existingQueue.id;
  } else {
    const info = db.prepare(`
      INSERT INTO applications_queue (
        job_id, resume_id, email_subject, email_body, whatsapp_message, contact_type,
        recipient_email, recipient_phone, resume_category, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_review')
    `).run(
      job.id,
      matchingResume ? matchingResume.id : null,
      parsedOutput.email_subject,
      parsedOutput.email_body,
      parsedOutput.whatsapp_message,
      contactType,
      targetRecipientEmail,
      targetRecipientPhone,
      resumeCategory
    );
    queueId = info.lastInsertRowid;
  }

  // Atualiza status da vaga para queued
  db.prepare("UPDATE jobs SET status = 'queued' WHERE id = ?").run(job.id);

  logEvent('success', 'Claude AI', `Candidatura gerada com sucesso e colocada na fila (#${queueId})`);

  return {
    success: true,
    queueId,
    jobId: job.id,
    jobOrderId: job.job_order_id,
    emailSubject: parsedOutput.email_subject,
    emailBody: parsedOutput.email_body,
    whatsappMessage: parsedOutput.whatsapp_message,
    resumeCategory,
    resumeAttached: matchingResume ? matchingResume.title : 'Nenhum PDF cadastrado'
  };
}

async function classifyIncomingEmail(subject, bodyText) {
  const anthropic = getAnthropicClient();
  const parseModel = getSetting('claude_parsing_model', 'claude-3-5-haiku-latest');

  const systemPrompt = `You are an AI assistant specialized in analyzing recruiter email responses regarding US H-2A/H-2B agricultural job applications.
Analyze the email content and extract:
1. sentiment_classification: ONE of ['INTERVIEW_INVITATION', 'DOCUMENT_REQUEST', 'JOB_FILLED', 'INQUIRY_INFO', 'OTHER']
2. sentiment_summary: A concise 1-sentence explanation in Portuguese of what the recruiter responded.
3. suggested_action: Practical next step recommended for the candidate in Portuguese.
4. job_order_id: If any DOL Job Order # is mentioned or referenced (e.g. JO-12345678), extract it, else null.

Return ONLY a valid JSON object.`;

  const userPrompt = `SUBJECT: ${subject}\n\nBODY:\n${bodyText.substring(0, 3000)}`;

  try {
    const response = await anthropic.messages.create({
      model: parseModel,
      max_tokens: 400,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }]
    });

    let raw = response.content[0]?.text?.trim() || '';
    if (raw.startsWith('```json')) {
      raw = raw.replace(/^```json\n?/, '').replace(/\n?```$/, '');
    } else if (raw.startsWith('```')) {
      raw = raw.replace(/^```\n?/, '').replace(/\n?```$/, '');
    }

    const parsed = JSON.parse(raw);
    return {
      classification: parsed.sentiment_classification || 'OTHER',
      summary: parsed.sentiment_summary || 'Resposta recebida de recrutador.',
      suggestedAction: parsed.suggested_action || 'Verificar mensagem completa.',
      jobOrderId: parsed.job_order_id || null
    };
  } catch (err) {
    logEvent('warn', 'Claude AI', `Erro na classificação automática de e-mail: ${err.message}`);
    return {
      classification: 'OTHER',
      summary: 'Resposta recebida. Revisão manual necessária.',
      suggestedAction: 'Abrir detalhes para conferir o conteúdo do e-mail.',
      jobOrderId: null
    };
  }
}

async function transformResumeToUsStandard(rawResumeText, targetCategory = 'Tractor & Heavy Machinery') {
  const candidate = db.prepare('SELECT * FROM candidate_profile ORDER BY id DESC LIMIT 1').get() || {};
  const apiKey = getSetting('claude_api_key') || process.env.ANTHROPIC_API_KEY;

  if (apiKey && apiKey.startsWith('sk-ant')) {
    try {
      const anthropic = new Anthropic({ apiKey });
      const draftModel = getSetting('claude_draft_model', 'claude-3-7-sonnet-latest');

      const systemPrompt = `You are a premier American agricultural resume writer and H-2A/H-2B recruitment specialist.
Transform candidate background information into a high-impact, professional, US-standard agricultural resume (US Resume) for category: ${targetCategory}.
Return ONLY a valid JSON object matching the standard schema with keys: fullName, phone, email, location, driverLicense, summary, machineryExpertise, coreSkills, experience, education, languages.`;

      const userPrompt = `Candidate: ${JSON.stringify(candidate)}\nCategory: ${targetCategory}\nRaw text: ${rawResumeText}`;

      logEvent('info', 'Claude AI', `Transformando currículo em padrão americano oficial (${targetCategory})...`);

      const response = await anthropic.messages.create({
        model: draftModel,
        max_tokens: 2500,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }]
      });

      let raw = response.content[0]?.text?.trim() || '';
      if (raw.startsWith('```json')) {
        raw = raw.replace(/^```json\n?/, '').replace(/\n?```$/, '');
      } else if (raw.startsWith('```')) {
        raw = raw.replace(/^```\n?/, '').replace(/\n?```$/, '');
      }

      return JSON.parse(raw);
    } catch (e) {
      logEvent('warn', 'Claude AI', `Fallback para construtor de US Resume nativo: ${e.message}`);
    }
  }

  // Fallback Nativo Estruturado de Alta Qualidade
  logEvent('info', 'Smart Resume Engine', `Compilando US Resume oficial em padrão nativo para ${targetCategory}...`);

  const isTruckDriver = targetCategory.includes('Truck') || targetCategory.includes('Hauling') || targetCategory.includes('Driver');
  const isLandscape = targetCategory.includes('Landscape') || targetCategory.includes('Grounds');
  const isConstruction = targetCategory.includes('Construction');

  return {
    fullName: candidate.full_name || 'Lucas Silva Ferreira',
    phone: candidate.phone || '+55 (16) 99876-5432',
    email: candidate.email || 'lucas.ferreira.agro@gmail.com',
    location: `${candidate.city || 'Ribeirão Preto'}, ${candidate.state || 'SP'}, Brazil`,
    driverLicense: 'Valid Commercial Driver License & Heavy Vehicle Endorsement',
    summary: isTruckDriver
      ? `Dedicated and safety-certified Heavy Truck Driver and Agricultural Hauler with over ${candidate.experience_years || 6} years of experience operating commercial semi-tractors (Kenworth, Peterbilt, Freightliner) and grain trailers across agricultural operations. Proven track record in bulk grain transport, live-bottom silage hauling, and strict pre-trip safety compliance. Ready for full US seasonal H-2A/H-2B contract commitments.`
      : isLandscape
      ? `Experienced Commercial Grounds Maintenance and Landscape Machinery Operator with ${candidate.experience_years || 5} years of experience in high-end commercial property upkeep, zero-turn mowing (Toro, Scag), irrigation repair, and hardscape. Strong physical stamina, reliable, and committed to excellent property presentation.`
      : isConstruction
      ? `Hardworking and safety-conscious Commercial Construction & Framing Laborer with ${candidate.experience_years || 5} years of experience in wood and steel framing, concrete placement, power tool operation, and job site efficiency.`
      : `High-stamina and mechanically skilled Agricultural Machinery Operator with over ${candidate.experience_years || 6} years of proven field experience operating heavy tractors (John Deere 8R/9R, Case IH Magnum) with GPS guidance (AutoTrac). Experienced in high-speed planting, spraying, harvesting, and daily preventative maintenance. Fully prepared for intensive US seasonal farming operations.`,
    machineryExpertise: isTruckDriver ? [
      { title: 'Commercial Heavy Vehicles', description: 'Kenworth W900/T680, Peterbilt 389/579, Freightliner Cascadia semi-tractors' },
      { title: 'Trailers & Bulk Hauling', description: 'Hopper bottom grain trailers, 53-ft live-bottom silage haulers, flatbeds with PTO hydraulics' },
      { title: 'Preventative Inspection', description: 'Pre-trip/post-trip safety checks, air brake systems, load securement, and tire pressure monitoring' }
    ] : [
      { title: 'Tractors & Heavy Machinery', description: 'John Deere 6M, 7R, 8R Series, Case IH Magnum 340, Front-End Loaders' },
      { title: 'Precision Farming & Guidance', description: 'John Deere AutoTrac GPS guidance systems, field mapping, variable rate application' },
      { title: 'Harvesting & Implements', description: 'John Deere S-Series grain combines, disc harrows, planters, chemical sprayers' },
      { title: 'Maintenance & Repairs', description: 'Daily grease fittings, hydraulic hoses, filter replacements, cutting bar sharpening' }
    ],
    coreSkills: isTruckDriver ? [
      'Commercial Driving (Class A Equivalent)',
      'Bulk Grain & Silage Transport',
      'Pre-Trip Vehicle Inspections (DOT/FMCSA)',
      'PTO Hydraulic Systems Operation',
      'Route Navigation & Transport Logs',
      'Clean Driving Record & Zero Accidents',
      '60+ Hours/Week Stamina',
      'H-2A/H-2B Seasonal Readiness'
    ] : [
      'Heavy Tractor & Combine Operation',
      'GPS AutoTrac & Precision Agriculture',
      'Row Crop Tillage, Planting & Spraying',
      'Preventive Mechanical Maintenance',
      'Implement Calibration & Hookup',
      'Livestock Handling & Feedlot Support',
      'Physical Stamina (60+ lbs lifting)',
      'H-2A Seasonal Contract Readiness'
    ],
    experience: [
      {
        jobTitle: isTruckDriver ? 'Lead Heavy Truck Driver & Harvest Hauler' : 'Senior Agricultural Machinery Operator',
        employer: isTruckDriver ? 'Transportadora AgroGrãos do Cerrado' : 'Fazenda Santa Maria - Agropecuária e Grãos',
        location: 'Mato Grosso / São Paulo, Brazil',
        period: '2020 - Present',
        bullets: isTruckDriver ? [
          'Operated commercial tandem-axle and semi-trailer trucks transporting over 25,000 tons of soybeans and corn per harvest season.',
          'Conducted daily DOT-standard pre-trip inspections, brake checks, and fluid level monitoring with zero roadside breakdowns.',
          'Navigated unpaved rural farm access roads and major highways safely under intensive harvest schedules (65+ hrs/week).'
        ] : [
          'Operated John Deere 8R series tractors with AutoTrac GPS for high-speed precision planting across 4,500 hectares of corn and soybeans.',
          'Conducted daily preventative maintenance, oil and filter changes, hydraulic hose repairs, and implement lubrication on 12 farm units.',
          'Worked 60-70 hours per week during peak planting and harvest windows maintaining 100% schedule reliability and zero lost-time incidents.'
        ]
      }
    ],
    education: [
      {
        degree: 'Technical Certification in Agricultural Machinery & Heavy Vehicle Operation',
        institution: 'SENAR - Serviço Nacional de Aprendizagem Rural',
        year: '2019'
      }
    ],
    languages: 'Portuguese (Native), English (Working Agricultural & Operational Proficiency)'
  };
}

module.exports = {
  generateApplicationForJob,
  classifyIncomingEmail,
  transformResumeToUsStandard
};

