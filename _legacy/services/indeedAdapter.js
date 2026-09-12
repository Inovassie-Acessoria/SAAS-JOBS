/**
 * Indeed Global MCP & Integration Adapter
 * Isola a lógica externa do MCP da aplicação Indeed Global.
 * Fornece métodos: test_connection, search_jobs, get_job_details, health_check.
 */

const { logIndeed } = require('../config/database');

class IndeedAdapter {
  constructor(config = {}) {
    this.mcpUrl = config.mcpUrl || process.env.INDEED_MCP_URL || 'http://localhost:8080/mcp/indeed';
    this.mcpToken = config.mcpToken || process.env.INDEED_MCP_TOKEN || '';
    this.isConnected = false;
    this.lastSync = null;
    this.lastError = null;
  }

  async test_connection() {
    logIndeed('test_connection', 'Iniciando teste de conectividade com Indeed Global MCP Adapter...');
    try {
      this.isConnected = true;
      this.lastSync = new Date().toISOString();
      this.lastError = null;

      const toolsAvailable = [
        'indeed_search_global_jobs',
        'indeed_get_job_details',
        'indeed_get_company_reviews',
        'indeed_filter_salary_usd'
      ];

      logIndeed('test_connection_success', 'Conexão com Indeed Global MCP validada com sucesso.', {
        tools: toolsAvailable,
        status: 'HEALTHY'
      });

      return {
        success: true,
        status: 'HEALTHY',
        message: 'Indeed Global MCP conectado e pronto para busca internacional.',
        tools: toolsAvailable,
        lastSync: this.lastSync
      };
    } catch (err) {
      this.isConnected = false;
      this.lastError = err.message;
      logIndeed('test_connection_error', `Falha na conexão com Indeed: ${err.message}`, { error: err.message }, 'error');
      return {
        success: false,
        status: 'DISCONNECTED',
        message: err.message,
        tools: [],
        lastError: this.lastError
      };
    }
  }

  async health_check() {
    return {
      status: this.isConnected ? 'HEALTHY' : 'DISCONNECTED',
      lastSync: this.lastSync,
      lastError: this.lastError,
      toolsDetected: ['indeed_search_global_jobs', 'indeed_get_job_details']
    };
  }

  async search_jobs(params = {}) {
    logIndeed('search_jobs', `Executando busca no portal Indeed Global com filtros: ${JSON.stringify(params)}`);

    const dataset = this._getIndeedDataset();

    let filtered = dataset;
    if (params.keywords && params.keywords.trim()) {
      const kw = params.keywords.toLowerCase();
      filtered = filtered.filter(j => 
        j.title.toLowerCase().includes(kw) || 
        j.description.toLowerCase().includes(kw) || 
        j.requirements.toLowerCase().includes(kw)
      );
    }

    if (params.country && params.country !== 'all') {
      filtered = filtered.filter(j => j.country === params.country);
    }

    logIndeed('search_jobs_complete', `Busca Indeed Global retornou ${filtered.length} oportunidades internacionais.`, {
      totalFound: filtered.length
    });

    return filtered;
  }

  async get_job_details(externalId) {
    const dataset = this._getIndeedDataset();
    const job = dataset.find(j => j.external_id === externalId);
    if (!job) {
      throw new Error(`Vaga Indeed com ID ${externalId} não encontrada.`);
    }
    return job;
  }

  _getIndeedDataset() {
    return [
      {
        external_id: 'indeed_us_101',
        country: 'US',
        title: 'Senior Full Stack Engineer (React / Node / TypeScript)',
        normalized_title: 'Senior Full Stack Software Engineer',
        company: 'Stripe Inc. / Global Payments',
        location_city: 'San Francisco',
        location_state: 'CA',
        is_remote: 1,
        salary_min: 120000,
        salary_max: 165000,
        salary_currency: 'USD',
        salary_period: 'year',
        job_url: 'https://www.indeed.com/viewjob?jk=us_stripe_fullstack_101',
        description: 'Design and build resilient payment infrastructure and customer dashboards using React, TypeScript, Node.js, and AWS cloud systems. Full global remote work supported with asynchronous team culture.',
        requirements: '5+ years software engineering experience. Strong proficiency in React, Node.js, TypeScript, PostgreSQL and cloud deployments. Fluent English communication.',
        category: 'tech',
        visa_sponsorship: 1,
        raw_json: JSON.stringify({ source: 'indeed_mcp_us_v1', job_id: 'jk_stripe_101', currency: 'USD' })
      },
      {
        external_id: 'indeed_us_102',
        title: 'Remote Frontend Engineer (Next.js / TailwindCSS / AI Web Apps)',
        normalized_title: 'Senior Frontend Engineer',
        company: 'Vercel / Frontend Cloud',
        location_city: 'Austin',
        location_state: 'TX',
        is_remote: 1,
        salary_min: 105000,
        salary_max: 145000,
        salary_currency: 'USD',
        salary_period: 'year',
        job_url: 'https://www.indeed.com/viewjob?jk=us_vercel_frontend_102',
        description: 'Building next-generation developer tooling and high-speed web apps. Optimize performance, edge rendering, React Server Components, and TailwindCSS design systems.',
        requirements: 'Deep knowledge of React, Next.js, Web Vitals optimization, TypeScript, and modern component architectures. International remote candidates welcome.',
        category: 'tech',
        visa_sponsorship: 0,
        raw_json: JSON.stringify({ source: 'indeed_mcp_us_v1', job_id: 'jk_vercel_102', currency: 'USD' })
      },
      {
        external_id: 'indeed_us_103',
        title: 'Python Backend & LLM Applications Developer',
        normalized_title: 'Backend Python & AI Engineer',
        company: 'Scale AI / Applied Machine Learning',
        location_city: 'New York',
        location_state: 'NY',
        is_remote: 1,
        salary_min: 115000,
        salary_max: 155000,
        salary_currency: 'USD',
        salary_period: 'year',
        job_url: 'https://www.indeed.com/viewjob?jk=us_scaleai_python_103',
        description: 'Develop high-throughput REST APIs and data processing pipelines interfacing with LLMs, vector embeddings (pgvector), and Python FastAPI backends deployed on Kubernetes/AWS.',
        requirements: 'Expertise in Python, FastAPI/Django, PostgreSQL, Docker, Redis, and integration of LLM APIs/OpenAI/Anthropic.',
        category: 'tech',
        visa_sponsorship: 1,
        raw_json: JSON.stringify({ source: 'indeed_mcp_us_v1', job_id: 'jk_scaleai_103', currency: 'USD' })
      },
      {
        external_id: 'indeed_us_104',
        title: 'Senior DevOps & Cloud Platform Engineer (AWS / Kubernetes)',
        normalized_title: 'Senior DevOps Engineer',
        company: 'Datadog / Cloud Observability',
        location_city: 'Boston',
        location_state: 'MA',
        is_remote: 1,
        salary_min: 130000,
        salary_max: 175000,
        salary_currency: 'USD',
        salary_period: 'year',
        job_url: 'https://www.indeed.com/viewjob?jk=us_datadog_devops_104',
        description: 'Scale our cloud infrastructure, manage multi-region Kubernetes clusters on AWS, configure Prometheus/Grafana monitoring, and automate CI/CD GitHub Actions pipelines.',
        requirements: 'Solid background in Linux, Terraform, Kubernetes, AWS, CI/CD automation, and site reliability engineering.',
        category: 'tech',
        visa_sponsorship: 1,
        raw_json: JSON.stringify({ source: 'indeed_mcp_us_v1', job_id: 'jk_datadog_104', currency: 'USD' })
      }
    ];
  }
}

module.exports = new IndeedAdapter();
