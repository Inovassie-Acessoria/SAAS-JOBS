const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');

/**
 * PDF Generator Service
 * Gera currículos profissionais elegantes no padrão oficial americano (US Resume)
 */

function generateUsResumePdf(resumeData, outputPath) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4',
        margins: { top: 40, bottom: 40, left: 45, right: 45 }
      });

      const writeStream = fs.createWriteStream(outputPath);
      doc.pipe(writeStream);

      // Colors
      const primaryColor = '#0f172a'; // Deep Navy
      const accentColor = '#0284c7';  // Ocean Blue
      const textColor = '#334155';    // Slate Gray
      const lightBg = '#f1f5f9';

      // --- HEADER ---
      doc.fontSize(22)
         .font('Helvetica-Bold')
         .fillColor(primaryColor)
         .text(resumeData.fullName || 'AGRICULTURAL MACHINERY OPERATOR', { align: 'center' });

      doc.moveDown(0.2);

      // Contact Line
      const contactInfo = [
        resumeData.phone ? `Phone: ${resumeData.phone}` : null,
        resumeData.email ? `Email: ${resumeData.email}` : null,
        resumeData.location ? `Location: ${resumeData.location}` : null,
        resumeData.driverLicense ? `Driver License: ${resumeData.driverLicense}` : 'Valid Driver License',
        'Status: Ready for H-2A/H-2B Visa'
      ].filter(Boolean).join('  |  ');

      doc.fontSize(9)
         .font('Helvetica')
         .fillColor(accentColor)
         .text(contactInfo, { align: 'center' });

      doc.moveDown(0.6);
      
      // Horizontal Line
      doc.strokeColor(accentColor)
         .lineWidth(1.5)
         .moveTo(45, doc.y)
         .lineTo(550, doc.y)
         .stroke();

      doc.moveDown(0.8);

      // --- PROFESSIONAL SUMMARY ---
      renderSectionHeader(doc, 'PROFESSIONAL SUMMARY', accentColor, primaryColor);
      doc.fontSize(10)
         .font('Helvetica')
         .fillColor(textColor)
         .text(resumeData.summary || 'Experienced and safety-dedicated heavy agricultural machinery operator with a proven track record across commercial crop farming and mechanized harvesting operations.', {
           lineGap: 3,
           align: 'justify'
         });

      doc.moveDown(0.8);

      // --- MACHINERY & EQUIPMENT EXPERTISE ---
      if (resumeData.machineryExpertise && resumeData.machineryExpertise.length > 0) {
        renderSectionHeader(doc, 'MACHINERY & TECHNICAL PROFICIENCY', accentColor, primaryColor);
        doc.fontSize(9.5).font('Helvetica').fillColor(textColor);
        
        resumeData.machineryExpertise.forEach(item => {
          doc.font('Helvetica-Bold').fillColor(primaryColor).text('• ' + item.title + ': ', { continued: true })
             .font('Helvetica').fillColor(textColor).text(item.description, { lineGap: 2 });
        });
        doc.moveDown(0.8);
      }

      // --- CORE COMPETENCIES ---
      if (resumeData.coreSkills && resumeData.coreSkills.length > 0) {
        renderSectionHeader(doc, 'CORE COMPETENCIES & FIELD SKILLS', accentColor, primaryColor);
        doc.fontSize(9.5).font('Helvetica').fillColor(textColor);
        
        // Render in 2 columns
        const midPoint = Math.ceil(resumeData.coreSkills.length / 2);
        const col1 = resumeData.coreSkills.slice(0, midPoint);
        const col2 = resumeData.coreSkills.slice(midPoint);

        const startY = doc.y;
        col1.forEach(skill => {
          doc.text('✔  ' + skill, 45, undefined, { lineGap: 2 });
        });

        doc.y = startY;
        col2.forEach(skill => {
          doc.text('✔  ' + skill, 300, undefined, { lineGap: 2 });
        });

        doc.x = 45;
        doc.moveDown(1);
      }

      // --- WORK EXPERIENCE ---
      if (resumeData.experience && resumeData.experience.length > 0) {
        renderSectionHeader(doc, 'PROFESSIONAL EXPERIENCE', accentColor, primaryColor);

        resumeData.experience.forEach(exp => {
          doc.font('Helvetica-Bold').fontSize(10.5).fillColor(primaryColor).text(exp.role || 'Farm Equipment Operator', { continued: true })
             .font('Helvetica-Oblique').fontSize(9.5).fillColor(accentColor).text(` — ${exp.company || 'Commercial Agricultural Enterprise'}`, { continued: true })
             .font('Helvetica').fontSize(9).fillColor('#64748b').text(` (${exp.period || '2020 - Present'})`, { align: 'right' });

          doc.moveDown(0.2);
          if (exp.bullets && Array.isArray(exp.bullets)) {
            doc.fontSize(9.5).font('Helvetica').fillColor(textColor);
            exp.bullets.forEach(b => {
              doc.text('• ' + b, { indent: 10, lineGap: 2 });
            });
          }
          doc.moveDown(0.6);
        });
      }

      // --- EDUCATION & CERTIFICATIONS ---
      renderSectionHeader(doc, 'EDUCATION, LICENSES & READINESS', accentColor, primaryColor);
      doc.fontSize(9.5).font('Helvetica').fillColor(textColor);
      
      const eduList = resumeData.education || [
        'High School Diploma (Completed)',
        'Valid Commercial Driver License & Heavy Vehicle Endorsement',
        'OSHA / Agricultural Safety & Chemical Application Awareness',
        'Physical Capability: Capable of lifting 60+ lbs and working long seasonal outdoor shifts'
      ];

      eduList.forEach(e => {
        doc.text('• ' + e, { indent: 10, lineGap: 2 });
      });

      doc.end();

      writeStream.on('finish', () => {
        resolve({ success: true, outputPath });
      });

      writeStream.on('error', (err) => {
        reject(err);
      });
    } catch (err) {
      reject(err);
    }
  });
}

function generateTechResumePdf(resumeData, outputPath, language = 'pt') {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4',
        margins: { top: 35, bottom: 35, left: 40, right: 40 }
      });

      const writeStream = fs.createWriteStream(outputPath);
      doc.pipe(writeStream);

      const isEn = language === 'en';
      const primaryColor = '#0f172a'; // Slate 900
      const accentColor = '#6366f1';  // Indigo Accent
      const textColor = '#334155';    // Slate 700
      const subColor = '#64748b';     // Slate 500

      // --- HEADER ---
      doc.fontSize(22)
         .font('Helvetica-Bold')
         .fillColor(primaryColor)
         .text(resumeData.fullName || 'Lucas Ferreira da Silva', { align: 'center' });

      doc.moveDown(0.15);

      doc.fontSize(12)
         .font('Helvetica-Bold')
         .fillColor(accentColor)
         .text(resumeData.headline || (isEn ? 'Senior Full Stack Developer & Growth Marketing Specialist' : 'Desenvolvedor Full Stack Sênior & Especialista em Growth Marketing'), { align: 'center' });

      doc.moveDown(0.25);

      // Contact & Links
      const contactItems = [
        resumeData.phone ? `Tel: ${resumeData.phone}` : null,
        resumeData.email ? `Email: ${resumeData.email}` : null,
        resumeData.city && resumeData.state ? `${resumeData.city}/${resumeData.state}` : 'Brasil',
        resumeData.linkedinUrl ? 'LinkedIn' : null,
        resumeData.githubUrl ? 'GitHub' : null,
        resumeData.portfolioUrl ? 'Portfólio' : null
      ].filter(Boolean).join('  •  ');

      doc.fontSize(8.5)
         .font('Helvetica')
         .fillColor(subColor)
         .text(contactItems, { align: 'center' });

      doc.moveDown(0.5);

      // Separator Line
      doc.strokeColor(accentColor)
         .lineWidth(1.2)
         .moveTo(40, doc.y)
         .lineTo(555, doc.y)
         .stroke();

      doc.moveDown(0.6);

      // --- SUMMARY ---
      renderSectionHeader(doc, isEn ? 'PROFESSIONAL SUMMARY' : 'RESUMO PROFISSIONAL', accentColor, primaryColor);
      doc.fontSize(9.5)
         .font('Helvetica')
         .fillColor(textColor)
         .text(resumeData.bio || (isEn
           ? 'Results-driven Full Stack Software Engineer and Growth Marketing Specialist with 6+ years of experience designing scalable web applications and high-ROI digital acquisition channels. Proven expertise in modern React/Next.js architectures, backend API systems, and performance analytics.'
           : 'Profissional híbrido com mais de 6 anos de experiência sólida em Engenharia de Software e Estratégias de Aquisição e Performance (Growth Marketing). Especialista em desenhar arquiteturas web modernas em React/Node.js e alavancar canais de receita através de dados e automações.'), {
           lineGap: 2.5,
           align: 'justify'
         });

      doc.moveDown(0.6);

      // --- TECHNICAL & MARKETING SKILLS ---
      renderSectionHeader(doc, isEn ? 'TECHNICAL & GROWTH COMPETENCIES' : 'COMPETÊNCIAS TÉCNICAS & MARKETING', accentColor, primaryColor);
      doc.fontSize(9).font('Helvetica').fillColor(textColor);

      const skillsList = [
        {
          title: isEn ? 'Software & Web Development' : 'Desenvolvimento & Engenharia Web',
          content: resumeData.techSkills || 'React, Next.js, Node.js, TypeScript, Python, PostgreSQL, REST APIs, Docker, Git, TailwindCSS, AWS'
        },
        {
          title: isEn ? 'Growth Marketing & Paid Acquisition' : 'Growth, Mídia Paga & Performance',
          content: resumeData.marketingSkills || 'Google Ads, Meta Ads (Facebook/Instagram), Tráfego Pago, Copywriting, Google Analytics 4, SEO, CRM HubSpot'
        },
        {
          title: isEn ? 'Languages & Soft Skills' : 'Idiomas & Práticas Ágeis',
          content: isEn ? 'English (Fluent / Professional Working), Portuguese (Native), Agile/Scrum, Asynchronous Collaboration, Problem Solving' : 'Inglês (Avançado / Fluente para Negócios), Português (Nativo), Scrum/Kanban, Comunicação Clara e Orientação a Resultados'
        }
      ];

      skillsList.forEach(s => {
        doc.font('Helvetica-Bold').fillColor(primaryColor).text(`• ${s.title}: `, { continued: true })
           .font('Helvetica').fillColor(textColor).text(s.content, { lineGap: 2 });
      });

      doc.moveDown(0.6);

      // --- PROFESSIONAL EXPERIENCE ---
      renderSectionHeader(doc, isEn ? 'WORK EXPERIENCE' : 'EXPERIÊNCIA PROFISSIONAL', accentColor, primaryColor);

      const experiences = resumeData.experiences || [
        {
          role: isEn ? 'Lead Full Stack & Growth Engineer' : 'Engenheiro Full Stack & Especialista em Growth',
          company: 'TechGrowth Labs & SaaS Ventures',
          period: isEn ? '2021 - Present' : '2021 - Atual',
          bullets: isEn ? [
            'Architected and deployed full-stack web applications using React, Next.js, Node.js, and PostgreSQL serving 100k+ monthly active users.',
            'Scaled paid acquisition funnels across Meta and Google Ads, reducing Customer Acquisition Cost (CAC) by 32% while increasing MRR.',
            'Implemented automated end-to-end data tracking pipelines integrating GA4, Google Tag Manager, and HubSpot CRM.'
          ] : [
            'Desenvolvimento e arquitetura de aplicações web completas em React, Next.js, Node.js e PostgreSQL com alta disponibilidade.',
            'Gestão de campanhas de alta performance em Google Ads e Meta Ads com redução de 32% no CAC e otimização contínua de funil.',
            'Implementação de rastreamento avançado de conversões com GA4, Google Tag Manager e integrações de CRM via Webhooks.'
          ]
        },
        {
          role: isEn ? 'Software Developer & Digital Strategist' : 'Desenvolvedor de Software & Estrategista Digital',
          company: 'Digital Solutions Enterprise',
          period: isEn ? '2019 - 2021' : '2019 - 2021',
          bullets: isEn ? [
            'Developed responsive client portals and RESTful backend APIs with TypeScript, Node.js, and modern UI component systems.',
            'Executed landing page A/B tests and conversion rate optimization (CRO) boosting overall lead capture rates by 45%.'
          ] : [
            'Construção de portais corporativos e APIs RESTful em TypeScript e Node.js com interfaces modernas e responsivas.',
            'Execução de testes A/B de páginas de vendas e landing pages, aumentando as taxas de conversão de leads em 45%.'
          ]
        }
      ];

      experiences.forEach(exp => {
        doc.font('Helvetica-Bold').fontSize(10).fillColor(primaryColor).text(exp.role, { continued: true })
           .font('Helvetica-Oblique').fontSize(9).fillColor(accentColor).text(` — ${exp.company}`, { continued: true })
           .font('Helvetica').fontSize(8.5).fillColor(subColor).text(` (${exp.period})`, { align: 'right' });

        doc.moveDown(0.15);
        if (exp.bullets && Array.isArray(exp.bullets)) {
          doc.fontSize(8.8).font('Helvetica').fillColor(textColor);
          exp.bullets.forEach(b => {
            doc.text('• ' + b, { indent: 8, lineGap: 1.8 });
          });
        }
        doc.moveDown(0.4);
      });

      // --- EDUCATION ---
      renderSectionHeader(doc, isEn ? 'EDUCATION & CERTIFICATIONS' : 'FORMAÇÃO ACADÊMICA & CERTIFICAÇÕES', accentColor, primaryColor);
      doc.fontSize(8.8).font('Helvetica').fillColor(textColor);

      const education = isEn ? [
        'Bachelor of Science in Information Systems / Computer Science (Completed)',
        'Google Ads Search & Measurement Certified Professional',
        'Meta Certified Digital Marketing Associate'
      ] : [
        'Graduação em Sistemas de Informação / Ciência da Computação (Concluído)',
        'Certificação Profissional Google Ads & Google Analytics 4',
        'Certificação Meta Media Buying & Tráfego de Performance'
      ];

      education.forEach(e => {
        doc.text('• ' + e, { indent: 8, lineGap: 1.8 });
      });

      doc.end();

      writeStream.on('finish', () => {
        resolve({ success: true, outputPath });
      });

      writeStream.on('error', (err) => {
        reject(err);
      });
    } catch (err) {
      reject(err);
    }
  });
}

function renderSectionHeader(doc, title, accentColor, primaryColor) {
  doc.fontSize(11)
     .font('Helvetica-Bold')
     .fillColor(primaryColor)
     .text(title);
  
  doc.strokeColor(accentColor)
     .lineWidth(0.8)
     .moveTo(40, doc.y + 2)
     .lineTo(555, doc.y + 2)
     .stroke();

  doc.moveDown(0.4);
}

module.exports = {
  generateUsResumePdf,
  generateTechResumePdf
};

