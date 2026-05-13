export type SpendingLimitPeriod = 'daily' | 'weekly' | 'monthly';

export type ParsedIntent =
  | {
      type: 'register-transaction';
      kind: 'expense' | 'income';
      amountCents: number;
      category: string;
      description: string;
      occurredAtIso: string;
    }
  | {
      type: 'monthly-summary';
      month: number;
      year: number;
    }
  | {
      type: 'delete-last-transaction';
      kind: 'expense' | 'income';
    }
  | {
      type: 'correct-last-transaction';
      kind: 'expense' | 'income';
      category?: string;
      newAmountCents: number;
    }
  | {
      type: 'set-spending-limit';
      period: SpendingLimitPeriod;
      amountCents: number;
    }
  | {
      type: 'set-spending-limit-missing-amount';
      period: SpendingLimitPeriod;
    }
  | {
      type: 'clear-spending-limit';
      period: SpendingLimitPeriod;
    }
  | {
      type: 'list-spending-limits';
    }
  | {
      type: 'ask-current-total';
    }
  | {
      type: 'ask-month-summary';
      month: number;
      year: number;
    }
  | {
      type: 'ask-explanation';
    }
  | {
      type: 'ask-confirmation';
    }
  | {
      type: 'ask-breakdown';
      month: number;
      year: number;
    }
  | {
      type: 'ask-projection-reason';
    }
  | {
      type: 'confirm-transaction-action';
      action: 'register-transaction';
      amountCents?: number;
      kind?: 'expense' | 'income';
      category?: string;
      description?: string;
      occurredAtIso?: string;
      reason: string;
    }
  | {
      type: 'full-expense-list';
      period: 'today' | 'this-week' | 'this-month' | 'last-month' | 'last-2-months' | 'last-3-months';
    }
  | {
      type: 'ask-expense-period';
    }
  | {
      type: 'set-savings-goal';
      description: string;
      targetAmountCents: number;
      deadlineIso: string;
    }
  | {
      type: 'ask-savings-goal-status';
    }
  | {
      type: 'cancel-savings-goal';
    }
  | {
      type: 'set-family-vault';
      description: string;
      targetAmountCents: number;
      deadlineIso: string;
    }
  | {
      type: 'ask-family-vault-status';
    }
  | {
      type: 'cancel-family-vault';
    }
  | {
      type: 'ask-family-meeting';
    }
  | {
      type: 'simulate-decision';
      rawQuery: string;
    }
  | {
      type: 'ask-couple-balance';
    }
  | {
      type: 'register-transaction-missing-info';
    }
  | {
      type: 'help';
      reason: string;
    }
  | {
      type: 'connect-bank';
    }
  | {
      type: 'disconnect-bank';
    }
  | {
      type: 'ask-bank-status';
    };

export type InboundMessage = {
  from: string;
  text: string;
  timestamp?: string;
  name?: string;
};
