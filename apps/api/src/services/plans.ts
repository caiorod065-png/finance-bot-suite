export type PlanCode = 'free' | 'essential' | 'premium' | 'family' | 'elite';
export const FAMILY_EXTRA_MEMBER_MONTHLY_FEE_CENTS = 3490;
export const FAMILY_BASE_MEMBER_LIMIT = 3;

export type PlanFeature =
  | 'goals'
  | 'reminders'
  | 'insights'
  | 'recurring'
  | 'cashflow'
  | 'investment_simulator'
  | 'gamification'
  | 'health_score'
  | 'family_mode'
  | 'visual_monthly_report'
  | 'open_banking_import';

export type PlanDefinition = {
  code: PlanCode;
  name: string;
  setupFeeCents: number;
  monthlyFeeCents: number;
  monthlyMessageLimit: number;
  features: PlanFeature[];
  aiTier: 'basic' | 'assistida' | 'avancada' | 'colaborativa' | 'proativa';
  proactiveLevel: 'none' | 'standard' | 'advanced' | 'max';
  groupMemberLimit: number;
  shortPitch: string;
};

const plans: Record<PlanCode, PlanDefinition> = {
  free: {
    code: 'free',
    name: 'Gratuito',
    setupFeeCents: 0,
    monthlyFeeCents: 0,
    monthlyMessageLimit: 20,
    features: ['goals', 'gamification', 'health_score'],
    aiTier: 'basic',
    proactiveLevel: 'none',
    groupMemberLimit: 1,
    shortPitch: 'Comece sem custo e teste o fluxo básico da Iara.'
  },
  essential: {
    code: 'essential',
    name: 'Essencial',
    setupFeeCents: 0,
    monthlyFeeCents: 4990,
    monthlyMessageLimit: 180,
    features: ['goals', 'reminders', 'gamification', 'health_score'],
    aiTier: 'assistida',
    proactiveLevel: 'standard',
    groupMemberLimit: 1,
    shortPitch: 'Controle pessoal diário com lembretes e score financeiro.'
  },
  premium: {
    code: 'premium',
    name: 'Premium',
    setupFeeCents: 0,
    monthlyFeeCents: 9990,
    monthlyMessageLimit: 550,
    features: [
      'goals',
      'reminders',
      'insights',
      'recurring',
      'cashflow',
      'investment_simulator',
      'gamification',
      'health_score',
      'visual_monthly_report'
    ],
    aiTier: 'avancada',
    proactiveLevel: 'standard',
    groupMemberLimit: 1,
    shortPitch: 'IA mais analítica com insights, previsão e simulador.'
  },
  family: {
    code: 'family',
    name: 'Família',
    setupFeeCents: 0,
    monthlyFeeCents: 17990,
    monthlyMessageLimit: 1200,
    features: [
      'goals',
      'reminders',
      'insights',
      'recurring',
      'cashflow',
      'investment_simulator',
      'gamification',
      'health_score',
      'family_mode',
      'visual_monthly_report'
    ],
    aiTier: 'colaborativa',
    proactiveLevel: 'advanced',
    groupMemberLimit: FAMILY_BASE_MEMBER_LIMIT,
    shortPitch: 'Plano para casa inteira: metas, limites e visão em grupo.'
  },
  elite: {
    code: 'elite',
    name: 'Elite',
    setupFeeCents: 0,
    monthlyFeeCents: 34990,
    monthlyMessageLimit: 2500,
    features: [
      'goals',
      'reminders',
      'insights',
      'recurring',
      'cashflow',
      'investment_simulator',
      'gamification',
      'health_score',
      'family_mode',
      'visual_monthly_report',
      'open_banking_import'
    ],
    aiTier: 'proativa',
    proactiveLevel: 'max',
    groupMemberLimit: 15,
    shortPitch: 'Experiência completa com IA proativa e operação avançada.'
  }
};

export function isPlanCode(value: string): value is PlanCode {
  return ['free', 'essential', 'premium', 'family', 'elite'].includes(value);
}

export function getPlanDefinition(planCode: string | null | undefined): PlanDefinition {
  if (planCode && isPlanCode(planCode)) {
    return plans[planCode];
  }
  return plans.essential;
}

export function listPlanDefinitions(): PlanDefinition[] {
  return Object.values(plans);
}

export function planHasFeature(planCode: string | null | undefined, feature: PlanFeature): boolean {
  const plan = getPlanDefinition(planCode);
  return plan.features.includes(feature);
}

export const allPlanFeatures: PlanFeature[] = [
  'goals',
  'reminders',
  'insights',
  'recurring',
  'cashflow',
  'investment_simulator',
  'gamification',
  'health_score',
  'family_mode',
  'visual_monthly_report',
  'open_banking_import'
];

export function featureLabel(feature: PlanFeature): string {
  const labels: Record<PlanFeature, string> = {
    goals: 'metas',
    reminders: 'lembretes de contas',
    insights: 'insights inteligentes',
    recurring: 'detecção de recorrências',
    cashflow: 'previsão de saldo',
    investment_simulator: 'simulador de investimentos',
    gamification: 'gamificação',
    health_score: 'score financeiro',
    family_mode: 'modo família',
    visual_monthly_report: 'relatório visual mensal',
    open_banking_import: 'importação por Open Banking'
  };
  return labels[feature];
}

export function minimumPlanForFeature(feature: PlanFeature): string {
  if (feature === 'reminders') return 'Essencial';
  if (feature === 'insights' || feature === 'recurring' || feature === 'cashflow' || feature === 'investment_simulator' || feature === 'visual_monthly_report') {
    return 'Premium';
  }
  if (feature === 'family_mode') return 'Família';
  if (feature === 'open_banking_import') return 'Elite';
  return 'Gratuito';
}
