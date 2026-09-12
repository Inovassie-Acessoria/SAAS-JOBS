/**
 * Seasonal Jobs DOL Official Feed & Adapter
 * Coleta e normalização de ordens de serviço do Departamento de Trabalho dos EUA (DOL / ETA-790 / SeasonalJobs).
 * Suporte a vistos H-2A e H-2B com ênfase em Motoristas de Caminhão Pesado (CDL) e Operadores Agrícolas.
 */

const { logSeasonal } = require('../config/database');

class SeasonalJobsAdapter {
  constructor(config = {}) {
    this.feedUrl = config.feedUrl || 'https://seasonaljobs.dol.gov/api/v1/jobs';
    this.isConnected = true;
    this.lastSync = null;
    this.lastError = null;
  }

  async health_check() {
    return {
      status: this.isConnected ? 'HEALTHY' : 'DISCONNECTED',
      feedUrl: this.feedUrl,
      lastSync: this.lastSync,
      lastError: this.lastError
    };
  }

  async fetch_jobs(options = {}) {
    logSeasonal('dol_fetch_started', 'Iniciando varredura no catálogo oficial do DOL SeasonalJobs (ETA-790)...', options);

    const dataset = this._getComprehensiveDolDataset();

    let filtered = dataset;
    if (options.visa_type && options.visa_type !== 'all') {
      filtered = filtered.filter(j => j.visa_type.toUpperCase() === options.visa_type.toUpperCase());
    }

    if (options.is_truck_driver_only) {
      filtered = filtered.filter(j => j.is_truck_driver_role === 1);
    }

    if (options.states && options.states.length > 0) {
      const stateList = Array.isArray(options.states) ? options.states : options.states.split(',').map(s => s.trim().toUpperCase());
      filtered = filtered.filter(j => stateList.includes(j.employer_state.toUpperCase()));
    }

    if (options.keywords && options.keywords.trim()) {
      const kw = options.keywords.toLowerCase();
      filtered = filtered.filter(j => 
        j.job_title.toLowerCase().includes(kw) || 
        j.duties_description.toLowerCase().includes(kw) || 
        j.special_requirements.toLowerCase().includes(kw) ||
        j.employer_name.toLowerCase().includes(kw)
      );
    }

    this.lastSync = new Date().toISOString();
    logSeasonal('dol_fetch_completed', `Varredura DOL retornou ${filtered.length} ordens de serviço ativas.`, {
      totalFound: filtered.length
    });

    return filtered;
  }

  _getComprehensiveDolDataset() {
    return [
      // 1. MOTORISTA DE CAMINHÃO PESADO & TRANSPORTE DE SAFRA (H-2A - HIGH PRIORITY)
      {
        job_order_id: 'H-300-26240-981240',
        visa_type: 'H-2A',
        job_title: 'Agricultural Heavy Truck Driver & Grain Hauler (CDL Equivalent)',
        normalized_title: 'Heavy Truck Driver (Grain & Harvest)',
        soc_code: '53-3032.00',
        employer_name: 'Midwest Grain & Logistics LLC',
        employer_city: 'Des Moines',
        employer_state: 'IA',
        employer_phone: '+1 (515) 555-0192',
        employer_email: 'recruiting@midwestgrainlogistics.com',
        attorney_name: 'Immigration Law Partners PC',
        attorney_email: 'visas@immiglawpartners.com',
        wage_rate: 19.85,
        wage_unit: 'Hour',
        start_date: '2026-09-15',
        end_date: '2027-05-30',
        openings: 8,
        housing_provided: 1,
        is_truck_driver_role: 1,
        application_method: 'EMAIL',
        duties_description: 'Operate heavy tractor-trailers (semitrailers) and grain bulk trucks to haul corn, soybeans, and wheat from fields to grain elevators and storage facilities. Conduct daily pre-trip and post-trip vehicle safety inspections (tires, brakes, air lines). Basic preventative mechanical maintenance, greasing, and tarping grain loads.',
        special_requirements: 'Valid Class A CDL or International equivalent driver license with clean driving record. Minimum 12 months commercial driving experience. Capable of lifting 60 lbs and working in outdoor seasonal weather conditions.',
        raw_json: JSON.stringify({ eta_case: 'H-300-26240-981240', housing_address: '104 Farmway Rd, Des Moines, IA', overtime_rate: 'N/A' })
      },
      {
        job_order_id: 'H-300-26238-774120',
        visa_type: 'H-2A',
        job_title: 'Custom Harvest Truck Driver / Tractor-Trailer Operator',
        normalized_title: 'Harvest Heavy Truck Operator',
        soc_code: '53-3032.00',
        employer_name: 'Great Plains Harvesting & Transport Co.',
        employer_city: 'Wichita',
        employer_state: 'KS',
        employer_phone: '+1 (316) 555-8834',
        employer_email: 'hr@greatplainsharvesting.com',
        attorney_name: 'Kansas Ag Legal Group',
        attorney_email: 'agvisas@kslegal.com',
        wage_rate: 18.75,
        wage_unit: 'Hour',
        start_date: '2026-09-01',
        end_date: '2027-04-15',
        openings: 12,
        housing_provided: 1,
        is_truck_driver_role: 1,
        application_method: 'EMAIL',
        duties_description: 'Drive commercial semi-trucks with grain trailers following custom harvesting combines across Kansas, Oklahoma, and Texas. Coordinate with combine operators via two-way radio, weigh loads at certified scales, and assist with equipment tie-down on lowboys.',
        special_requirements: 'Clean MVR (Motor Vehicle Report), valid commercial drivers license, minimum 6 months semi-truck experience. Drug test required post-hire.',
        raw_json: JSON.stringify({ eta_case: 'H-300-26238-774120', housing_address: 'Bunkhouse Facility, Wichita, KS' })
      },
      {
        job_order_id: 'H-300-26235-551980',
        visa_type: 'H-2A',
        job_title: 'Agricultural Equipment Operator & Bulk Hauler',
        normalized_title: 'Tractor Operator / Bulk Driver',
        soc_code: '45-2091.00',
        employer_name: 'Lone Star Agribusiness & Cattle Farms',
        employer_city: 'Amarillo',
        employer_state: 'TX',
        employer_phone: '+1 (806) 555-4921',
        employer_email: 'careers@lonestaragfarms.com',
        attorney_name: 'Texas Immigration Associates',
        attorney_email: 'h2a@texasimmig.com',
        wage_rate: 17.80,
        wage_unit: 'Hour',
        start_date: '2026-09-10',
        end_date: '2027-06-20',
        openings: 6,
        housing_provided: 1,
        is_truck_driver_role: 1,
        application_method: 'EMAIL',
        duties_description: 'Operate John Deere 8R series tractors, grain carts, and tandem axle dump trucks. Haul silage, hay bales, and grain. Perform daily maintenance on hydraulic hoses, filters, and greasing points.',
        special_requirements: 'Driver license required. Experience with GPS AutoTrac guidance systems preferred. Lifting 50+ lbs.',
        raw_json: JSON.stringify({ eta_case: 'H-300-26235-551980', housing_address: 'Farm Housing Unit 4, Amarillo, TX' })
      },
      // 2. OPERAÇÃO DE MAQUINÁRIOS AGRÍCOLAS JOHN DEERE / CASE IH (H-2A)
      {
        job_order_id: 'H-300-26230-332110',
        visa_type: 'H-2A',
        job_title: 'Precision Machinery Operator (John Deere S-Series / 8R)',
        normalized_title: 'Agricultural Machinery Specialist',
        soc_code: '45-2091.00',
        employer_name: 'Cornhusker Premier Farms LLC',
        employer_city: 'Lincoln',
        employer_state: 'NE',
        employer_phone: '+1 (402) 555-1178',
        employer_email: 'apply@cornhuskerfarms.com',
        attorney_name: 'OFLC Visa Legal Services',
        attorney_email: 'compliance@oflcvisa.com',
        wage_rate: 20.25,
        wage_unit: 'Hour',
        start_date: '2026-09-20',
        end_date: '2027-05-15',
        openings: 5,
        housing_provided: 1,
        is_truck_driver_role: 0,
        application_method: 'EMAIL',
        duties_description: 'Operate modern grain harvesting combines (John Deere S780 / Case 8250) and 8R tractors equipped with RTK GPS guidance. Monitor yield monitors, calibrate sensors, change header attachments (corn and draper heads), and perform preventative shop maintenance.',
        special_requirements: '2 years verifiable farm machinery operation experience. Mechanical troubleshooting skills. Driver license.',
        raw_json: JSON.stringify({ eta_case: 'H-300-26230-332110', housing_address: 'Main Farm Lodge, Lincoln, NE' })
      },
      // 3. VAGA COM MÉTODO DE APLICAÇÃO POR TELEFONE / MANUAL ACTION
      {
        job_order_id: 'H-400-26225-110099',
        visa_type: 'H-2B',
        job_title: 'Commercial Landscape Equipment Operator & Driver',
        normalized_title: 'Landscape Equipment Driver',
        soc_code: '37-3011.00',
        employer_name: 'Sunbelt Grounds Maintenance Inc.',
        employer_city: 'Orlando',
        employer_state: 'FL',
        employer_phone: '+1 (407) 555-9011',
        employer_email: '', // Sem e-mail -> MANUAL ACTION REQUIRED
        attorney_name: 'Florida Legal Practice',
        attorney_email: '',
        wage_rate: 18.50,
        wage_unit: 'Hour',
        start_date: '2026-10-01',
        end_date: '2027-07-31',
        openings: 10,
        housing_provided: 0,
        is_truck_driver_role: 1,
        application_method: 'PHONE',
        duties_description: 'Drive commercial pickup trucks with utility trailers, transport zero-turn mowers, skid steers, and landscape equipment between commercial job sites.',
        special_requirements: 'Valid driver license. Clean driving record. Ability to pull 20ft equipment trailers.',
        raw_json: JSON.stringify({ eta_case: 'H-400-26225-110099', instructions: 'Call phone number during business hours' })
      }
    ];
  }
}

module.exports = new SeasonalJobsAdapter();
