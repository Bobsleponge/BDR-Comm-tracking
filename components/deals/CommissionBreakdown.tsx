'use client';

import { format, addDays } from 'date-fns';
import type { Database } from '@/types/database';

type DealService = Database['public']['Tables']['deal_services']['Row'];

interface CommissionBreakdownProps {
  services: DealService[];
  totalCommission: number;
  baseCommissionRate: number;
}

export function CommissionBreakdown({
  services,
  totalCommission,
  baseCommissionRate,
}: CommissionBreakdownProps) {
  if (!services || services.length === 0) {
    return null;
  }

  const formatCurrency = (value: number) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value);
  };

  const formatPercent = (value: number) => {
    return `${(value * 100).toFixed(2)}%`;
  };

  const getBillingTypeLabel = (type: string) => {
    switch (type) {
      case 'one_off':
        return 'Once-Off Payment';
      case 'mrr':
        return 'Monthly Recurring Revenue (MRR)';
      case 'quarterly':
        return 'Recurring Quarterly';
      case 'deposit':
        return 'Deposit-Based Billing (50% / 50%)';
      case 'paid_on_completion':
        return 'Paid on Completion';
      default:
        return type;
    }
  };

  return (
    <div className="bg-white shadow rounded-lg overflow-hidden">
      <div className="px-6 py-4 border-b border-gray-200">
        <h3 className="text-lg font-medium text-gray-900">Commission Breakdown</h3>
        <p className="mt-1 text-sm text-gray-500">
          Total Commission: <span className="font-semibold text-gray-900">{formatCurrency(totalCommission)}</span>
        </p>
      </div>
      <div className="px-6 py-4">
        <div className="space-y-6">
          {services.map((service) => {
            const commissionRate = service.commission_rate ?? baseCommissionRate;
            const isMRR = service.billing_type === 'mrr';
            const annualizedValue = isMRR && service.monthly_price
              ? service.monthly_price * service.contract_months * service.quantity
              : null;

            return (
              <div key={service.id} className={`border-l-4 pl-4 ${(service as any).is_renewal ? 'border-amber-400' : 'border-indigo-500'}`}>
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h4 className="text-base font-medium text-gray-900">{service.service_name}</h4>
                      {(service as any).is_renewal === true || (service as any).is_renewal === 1 ? (
                        <span className="inline-flex items-center rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700 ring-1 ring-inset ring-amber-200/60">
                          Renewal
                        </span>
                      ) : null}
                    </div>
                    <p className="mt-1 text-sm text-gray-500">{getBillingTypeLabel(service.billing_type)}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-base font-semibold text-gray-900">
                      {formatCurrency(service.commission_amount)}
                    </p>
                    <p className="text-xs text-gray-500">Commission</p>
                  </div>
                </div>

                <div className="mt-3 space-y-2 text-sm">
                  {isMRR && service.monthly_price ? (
                    <>
                      <div className="flex justify-between">
                        <span className="text-gray-500">Monthly Price:</span>
                        <span className="text-gray-900">{formatCurrency(service.monthly_price)}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-500">Quantity:</span>
                        <span className="text-gray-900">{service.quantity}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-500">Contract Months:</span>
                        <span className="text-gray-900">{service.contract_months}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-500">Annualized Value (ACV):</span>
                        <span className="text-gray-900 font-medium">
                          {formatCurrency(annualizedValue || 0)}
                        </span>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="flex justify-between">
                        <span className="text-gray-500">Unit Price:</span>
                        <span className="text-gray-900">{formatCurrency(service.unit_price)}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-500">Quantity:</span>
                        <span className="text-gray-900">{service.quantity}</span>
                      </div>
                      {(service.billing_type === 'deposit' || service.billing_type === 'paid_on_completion') && service.completion_date && (
                        <>
                          <div className="flex justify-between">
                            <span className="text-gray-500">
                              {service.billing_type === 'paid_on_completion' ? 'Estimated Completion:' : 'Completion Date:'}
                            </span>
                            <span className="text-gray-900">
                              {format(new Date(service.completion_date), 'MMM d, yyyy')}
                            </span>
                          </div>
                          {service.billing_type === 'paid_on_completion' && (
                            <div className="mt-1 text-xs text-gray-500">
                              Commission payable: {format(addDays(new Date(service.completion_date), 7), 'MMM d, yyyy')} (7 days after completion)
                            </div>
                          )}
                        </>
                      )}
                      {service.billing_type === 'deposit' && (
                        <div className="mt-2 p-2 bg-blue-50 rounded text-xs text-blue-700">
                          Commission split: 50% on acceptance, 50% on completion date (7-day funds-processing delay for second 50%).
                          {service.completion_date && (
                            <span className="block mt-1">
                              Second payment due: {format(new Date(service.completion_date), 'MMM d, yyyy')} → commission payable: {format(addDays(new Date(service.completion_date), 7), 'MMM d, yyyy')}
                            </span>
                          )}
                        </div>
                      )}
                    </>
                  )}

                  <div className="pt-2 border-t border-gray-200">
                    {(service as any).is_renewal === true || (service as any).is_renewal === 1 ? (
                      <>
                        <div className="flex justify-between">
                          <span className="text-gray-500">Contract Value:</span>
                          <span className="text-gray-900 font-medium">
                            {formatCurrency(service.commissionable_value)}
                          </span>
                        </div>
                        {(service as any).original_service_value != null && (
                          <>
                            <div className="flex justify-between">
                              <span className="text-gray-500">Previous Deal Amount:</span>
                              <span className="text-gray-900">
                                {formatCurrency((service as any).original_service_value)}
                              </span>
                            </div>
                            <div className="flex justify-between">
                              <span className="text-gray-500">Uplift (commissionable):</span>
                              <span className="text-gray-900 font-medium">
                                {formatCurrency(Math.max(0, service.commissionable_value - ((service as any).original_service_value || 0)))}
                              </span>
                            </div>
                          </>
                        )}
                      </>
                    ) : (
                      <div className="flex justify-between">
                        <span className="text-gray-500">Commissionable Value:</span>
                        <span className="text-gray-900 font-medium">
                          {formatCurrency(service.commissionable_value)}
                        </span>
                      </div>
                    )}
                    <div className="flex justify-between mt-1">
                      <span className="text-gray-500">Commission Rate:</span>
                      <span className="text-gray-900">
                        {formatPercent(commissionRate)}
                        {service.commission_rate && (
                          <span className="text-xs text-gray-400 ml-1">(override)</span>
                        )}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

