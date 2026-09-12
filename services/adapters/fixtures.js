/**
 * Dados de EXEMPLO para desenvolvimento sem credencial (spec §0.7).
 *
 * Estes registros nunca são apresentados como reais: todo adapter que os usa
 * marca `fixtureMode: true` no retorno, e a interface rotula a origem.
 * Empresas e contatos são fictícios.
 */

function gupyJobs({ country = 'BR', keywords = '' } = {}) {
  const br = [
    {
      external_id: 'gupy-br-fx-001',
      title: 'Pessoa Desenvolvedora Full Stack Sênior',
      company: 'Fixture Fintech S.A.',
      location: 'São Paulo, SP',
      workplace_type: 'remote',
      job_type: 'CLT',
      salary_month: 16000,
      apply_url: 'https://example.invalid/vaga/fx-001',
      published_date: isoDaysAgo(2),
      description: 'Desenvolvimento de microsserviços em Node.js e TypeScript e interfaces em React/Next.js. Infraestrutura em AWS com PostgreSQL e esteiras de CI/CD.',
      requirements: 'Obrigatório: 5+ anos de experiência com desenvolvimento web. Domínio de React, Node.js e TypeScript. Desejável: Docker e Kubernetes. Diferencial: experiência com GraphQL.',
      category: 'tech'
    },
    {
      external_id: 'gupy-br-fx-002',
      title: 'Especialista em Mídia Paga e Performance',
      company: 'Fixture Retail Group',
      location: 'São Paulo, SP',
      workplace_type: 'hybrid',
      job_type: 'CLT',
      salary_month: 12500,
      apply_url: 'https://example.invalid/vaga/fx-002',
      published_date: isoDaysAgo(6),
      description: 'Gestão de campanhas em Google Ads e Meta Ads, análise via GA4 e Looker Studio, testes A/B e otimização de conversão.',
      requirements: 'Obrigatório: experiência comprovada com Google Ads e Meta Ads. Necessário domínio de GA4. Desejável: SQL. Diferencial: Power BI.',
      category: 'marketing'
    },
    {
      external_id: 'gupy-br-fx-003',
      title: 'Engenheiro(a) de Dados Pleno',
      company: 'Fixture Logística',
      location: 'Rio de Janeiro, RJ',
      workplace_type: 'remote',
      job_type: 'CLT',
      salary_month: 14000,
      apply_url: 'https://example.invalid/vaga/fx-003',
      published_date: isoDaysAgo(15),
      description: 'Construção de pipelines de dados com Python, Airflow e SQL avançado sobre PostgreSQL e data lake em AWS.',
      requirements: 'Obrigatório: SQL avançado e Python. Mínimo de 3 anos em engenharia de dados. Desejável: Airflow.',
      category: 'tech'
    }
  ];

  const us = [
    {
      external_id: 'gupy-us-fx-001',
      title: 'Senior Full Stack Engineer',
      company: 'Fixture Global Tech Inc.',
      location: 'Remote — United States',
      workplace_type: 'remote',
      job_type: 'Full-time',
      salary_min: 120000, salary_max: 160000, salary_currency: 'USD', salary_period: 'year',
      apply_url: 'https://example.invalid/job/us-fx-001',
      published_date: isoDaysAgo(3),
      description: 'Build and scale distributed services in Node.js and TypeScript with React front-ends on AWS.',
      requirements: 'Required: 5+ years of software engineering experience. Must have React, Node.js and TypeScript. Preferred: Kubernetes. Fluent English required.',
      category: 'tech'
    },
    {
      external_id: 'gupy-us-fx-002',
      title: 'Performance Marketing Manager',
      company: 'Fixture Commerce LLC',
      location: 'Austin, TX — Hybrid',
      workplace_type: 'hybrid',
      job_type: 'Full-time',
      salary_min: 95000, salary_max: 125000, salary_currency: 'USD', salary_period: 'year',
      apply_url: 'https://example.invalid/job/us-fx-002',
      published_date: isoDaysAgo(9),
      description: 'Own paid acquisition across Google Ads and Meta Ads. Report through GA4 and Looker Studio.',
      requirements: 'Required: 4+ years managing paid media budgets. Must have Google Ads and Meta Ads. Preferred: SQL and Power BI.',
      category: 'marketing'
    }
  ];

  const pool = String(country).toUpperCase() === 'US' ? us : br;
  return filterByKeywords(pool, keywords);
}

function indeedJobs({ country = 'US', keywords = '' } = {}) {
  const us = [
    {
      external_id: 'indeed-us-fx-001',
      title: 'Staff Software Engineer — Platform',
      company: 'Fixture Cloud Systems',
      location_city: 'Boston', location_state: 'MA', is_remote: 1,
      salary_min: 150000, salary_max: 190000, salary_currency: 'USD', salary_period: 'year',
      job_url: 'https://example.invalid/viewjob?jk=fx001',
      published_date: isoDaysAgo(1),
      description: 'Design multi-region Kubernetes infrastructure on AWS with Terraform and CI/CD automation.',
      requirements: 'Required: Kubernetes, Terraform and AWS. Must have 7+ years experience. Preferred: Go.',
      category: 'tech', visa_sponsorship: 1
    },
    {
      external_id: 'indeed-us-fx-002',
      title: 'Data Analyst',
      company: 'Fixture Health Partners',
      location_city: 'Remote', location_state: 'US', is_remote: 1,
      salary_min: 85000, salary_max: 110000, salary_currency: 'USD', salary_period: 'year',
      job_url: 'https://example.invalid/viewjob?jk=fx002',
      published_date: isoDaysAgo(20),
      description: 'Build dashboards in Looker Studio and Power BI over a PostgreSQL warehouse.',
      requirements: 'Required: advanced SQL. Preferred: Power BI and Python. Bachelor degree required.',
      category: 'tech', visa_sponsorship: 0
    }
  ];

  const br = [
    {
      external_id: 'indeed-br-fx-001',
      title: 'Desenvolvedor(a) Backend Python',
      company: 'Fixture Serviços Digitais',
      location_city: 'São Paulo', location_state: 'SP', is_remote: 1,
      salary_month: 13000, salary_currency: 'BRL', salary_period: 'month',
      job_url: 'https://example.invalid/viewjob?jk=fxbr001',
      published_date: isoDaysAgo(4),
      description: 'APIs em Python com FastAPI, PostgreSQL e Docker.',
      requirements: 'Obrigatório: Python e PostgreSQL. Mínimo de 4 anos. Desejável: Docker e FastAPI.',
      category: 'tech', visa_sponsorship: 0
    }
  ];

  const pool = String(country).toUpperCase() === 'BR' ? br : us;
  return filterByKeywords(pool, keywords);
}

/**
 * Ordens de serviço de exemplo. As datas cobrem 2026 e 2027 de propósito, para
 * que o motor de priorização 2027 (§33) tenha casos distintos para ordenar.
 */
function dolRecords() {
  return [
    {
      job_order_id: 'FX-H300-27001', visa_type: 'H-2A',
      job_title: 'Agricultural Equipment Operator',
      employer_name: 'Fixture Prairie Farms LLC',
      employer_city: 'Lincoln', employer_state: 'NE',
      employer_email: 'hiring@example.invalid', employer_phone: '+1 (555) 010-0001',
      wage_rate: '19.75', wage_unit: 'Hour',
      begin_date: '2027-01-15', end_date: '2027-10-20',
      openings: 6, hours_per_week: 48, housing_provided: 'Y',
      job_duties: 'Operate tractors and grain carts during planting and harvest. Perform daily preventative maintenance on hydraulic systems.',
      job_requirements: 'Valid driver license required. Minimum 12 months of agricultural machinery experience. Must be able to lift 50 lbs.'
    },
    {
      job_order_id: 'FX-H300-27002', visa_type: 'H-2A',
      job_title: 'Heavy Truck Driver — Grain Hauling',
      employer_name: 'Fixture Grain Logistics',
      employer_city: 'Des Moines', employer_state: 'IA',
      attorney_name: 'Fixture Immigration Counsel', attorney_email: 'visas@example.invalid',
      wage_rate: '21.40', wage_unit: 'Hour',
      begin_date: '2027-03-01', end_date: '2027-11-30',
      openings: 10, hours_per_week: 50, housing_provided: 'Y',
      job_duties: 'Drive tractor-trailers hauling grain from fields to elevators. Conduct pre-trip and post-trip inspections.',
      job_requirements: 'Class A CDL or international equivalent required. Clean driving record required. Minimum 6 months commercial driving.'
    },
    {
      job_order_id: 'FX-H400-26003', visa_type: 'H-2B',
      job_title: 'Hotel Housekeeper',
      employer_name: 'Fixture Mountain Resort',
      employer_city: 'Aspen', employer_state: 'CO',
      employer_email: 'jobs@example.invalid',
      wage_rate: '18.20', wage_unit: 'Hour',
      begin_date: '2026-11-01', end_date: '2027-04-15',
      openings: 14, hours_per_week: 40, housing_provided: 'Y',
      job_duties: 'Clean guest rooms and common areas. Restock linens and amenities. Report maintenance issues.',
      job_requirements: 'Prior housekeeping or hospitality experience preferred. Basic English communication required.'
    },
    {
      job_order_id: 'FX-H400-26004', visa_type: 'H-2B',
      job_title: 'Landscape Laborer',
      employer_name: 'Fixture Grounds Services',
      employer_city: 'Orlando', employer_state: 'FL',
      employer_phone: '+1 (555) 010-0004',
      wage_rate: '17.10', wage_unit: 'Hour',
      begin_date: '2026-03-01', end_date: '2026-10-31',
      openings: 8, hours_per_week: 40, housing_provided: 'N',
      job_duties: 'Mow, trim and maintain commercial landscapes. Operate zero-turn mowers and trimmers.',
      job_requirements: 'Ability to work outdoors in heat. Lifting 40 lbs required.'
    },
    {
      job_order_id: 'FX-H300-27005', visa_type: 'H-2A',
      job_title: 'Farm Worker — Fruit Harvest',
      employer_name: 'Fixture Orchards Inc.',
      employer_city: 'Yakima', employer_state: 'WA',
      employer_email: 'recruit@example.invalid',
      wage_rate: '18.90', wage_unit: 'Hour',
      begin_date: '2027-06-01', end_date: '2027-10-15',
      openings: 25, hours_per_week: 45, housing_provided: 'Y', transportation_provided: 'Y',
      job_duties: 'Harvest apples and pears by hand. Sort and pack fruit according to grade standards.',
      job_requirements: 'No prior experience required. Must be able to climb ladders and lift 50 lbs repeatedly.'
    },
    {
      job_order_id: 'FX-H300-28006', visa_type: 'H-2A',
      job_title: 'Livestock Worker',
      employer_name: 'Fixture Cattle Company',
      employer_city: 'Amarillo', employer_state: 'TX',
      employer_email: 'hr@example.invalid',
      wage_rate: '18.00', wage_unit: 'Hour',
      begin_date: '2028-02-01', end_date: '2028-12-01',
      openings: 4, hours_per_week: 48, housing_provided: 'Y',
      job_duties: 'Feed and care for cattle. Maintain fencing and water systems.',
      job_requirements: 'Experience with livestock preferred. Driver license required.'
    }
  ];
}

function filterByKeywords(pool, keywords) {
  if (!keywords || !String(keywords).trim()) return pool;
  const kw = String(keywords).toLowerCase();
  return pool.filter(j =>
    [j.title, j.description, j.requirements, j.company].filter(Boolean)
      .join(' ').toLowerCase().includes(kw)
  );
}

function isoDaysAgo(n) {
  const d = new Date(Date.now() - n * 86400000);
  return d.toISOString().slice(0, 10);
}

module.exports = { gupyJobs, indeedJobs, dolRecords };
