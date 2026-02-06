'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { calculateServiceCommission, calculateDealTotalCommission } from '@/lib/commission/calculator';
import { ClientForm } from '@/components/clients/ClientForm';

interface DealFormProps {
  dealId?: string;
  initialData?: any;
}

interface ServiceFormData {
  id?: string;
  service_name: string;
  billing_type: 'one_off' | 'mrr' | 'deposit' | 'quarterly';
  unit_price: string;
  monthly_price: string;
  quarterly_price: string;
  quantity: string;
  contract_months: string;
  contract_quarters: string;
  commission_rate: string;
  commissionable_value?: number;
  commission_amount?: number;
  completion_date?: string;
}

export function DealForm({ dealId, initialData }: DealFormProps) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [bdrReps, setBdrReps] = useState<any[]>([]);
  const [clients, setClients] = useState<any[]>([]);
  const [originalDeals, setOriginalDeals] = useState<any[]>([]);
  const [baseCommissionRate, setBaseCommissionRate] = useState(0.025);
  const [showClientModal, setShowClientModal] = useState(false);
  const [formData, setFormData] = useState({
    bdr_id: initialData?.bdr_id || '',
    client_id: initialData?.client_id || '',
    client_name: initialData?.client_name || '',
    service_type: initialData?.service_type || '',
    proposal_date: initialData?.proposal_date || '',
    close_date: initialData?.close_date || '',
    first_invoice_date: initialData?.first_invoice_date || '',
    status: initialData?.status || 'proposed',
    is_renewal: initialData?.is_renewal || false,
    original_deal_id: initialData?.original_deal_id || '',
    original_deal_value: initialData?.original_deal_value?.toString() || '',
    use_manual_original_value: initialData?.original_deal_value ? true : false,
    payout_months: initialData?.payout_months || 12,
    use_legacy_mode: false, // New field for legacy mode (no services)
    legacy_deal_value: '', // Deal value for legacy mode
  });

  // Initialize services from initialData or create one empty service
  const initialServices: ServiceFormData[] = initialData?.deal_services && initialData.deal_services.length > 0
    ? initialData.deal_services.map((s: any) => ({
        id: s.id,
        service_name: s.service_name || '',
        billing_type: s.billing_type || 'one_off',
        unit_price: s.unit_price?.toString() || '',
        monthly_price: s.monthly_price?.toString() || '',
        quarterly_price: s.quarterly_price?.toString() || '',
        quantity: s.quantity?.toString() || '1',
        contract_months: s.contract_months?.toString() || '12',
        contract_quarters: s.contract_quarters?.toString() || '4',
        commission_rate: s.commission_rate?.toString() || '',
        commissionable_value: s.commissionable_value,
        commission_amount: s.commission_amount,
        completion_date: s.completion_date || '',
      }))
    : [{
        service_name: '',
        billing_type: 'one_off' as const,
        unit_price: '',
        monthly_price: '',
        quarterly_price: '',
        quantity: '1',
        contract_months: '12',
        contract_quarters: '4',
        commission_rate: '',
      }];

  const [services, setServices] = useState<ServiceFormData[]>(initialServices);

  // Function to refresh clients list
  const refreshClients = async () => {
    const res = await fetch('/api/clients');
    if (res.ok) {
      const data = await res.json();
      const updatedClients = Array.isArray(data) ? data : [];
      setClients(updatedClients);
      return updatedClients;
    }
    return [];
  };

  // Handle client creation success
  const handleClientCreated = async (newClientId: string) => {
    const updatedClients = await refreshClients();
    const newClient = updatedClients.find(c => c.id === newClientId);
    setFormData({ 
      ...formData, 
      client_id: newClientId,
      client_name: newClient?.name || '',
    });
    setShowClientModal(false);
  };

  useEffect(() => {
    const fetchBdrReps = async () => {
      const res = await fetch('/api/bdr-reps');
      if (res.ok) {
        const data = await res.json();
        setBdrReps(Array.isArray(data) ? data : []);
        if (!formData.bdr_id && Array.isArray(data) && data.length > 0) {
          setFormData(prev => ({ ...prev, bdr_id: data[0].id }));
        }
      }
    };
    fetchBdrReps();

    const fetchClients = async () => {
      const res = await fetch('/api/clients');
      if (res.ok) {
        const data = await res.json();
        setClients(Array.isArray(data) ? data : []);
      }
    };
    fetchClients();

    // Fetch commission rules for base rate
    const fetchCommissionRules = async () => {
      try {
        const res = await fetch('/api/rules');
        if (res.ok) {
          const data = await res.json();
          if (data && data.base_rate) {
            setBaseCommissionRate(data.base_rate);
          }
        }
      } catch (err) {
        console.error('Failed to fetch commission rules:', err);
      }
    };
    fetchCommissionRules();

    // Fetch deals for original deal selection (only if creating renewal)
    const fetchOriginalDeals = async () => {
      if (formData.is_renewal && formData.client_name) {
        try {
          const res = await fetch(`/api/deals?client_name=${encodeURIComponent(formData.client_name)}`);
          if (res.ok) {
            const data = await res.json();
            // Filter out current deal and only show closed-won deals
            const filtered = Array.isArray(data) 
              ? data.filter((d: any) => d.id !== dealId && d.status === 'closed-won')
              : [];
            setOriginalDeals(filtered);
          }
        } catch (err) {
          console.error('Failed to fetch original deals:', err);
        }
      }
    };
    fetchOriginalDeals();
  }, [formData.is_renewal, formData.client_name, dealId]);

  // Calculate commission for a service
  const calculateServiceCommissionValue = (service: ServiceFormData) => {
    try {
      const unitPrice = parseFloat(service.unit_price) || 0;
      const monthlyPrice = service.monthly_price ? parseFloat(service.monthly_price) : null;
      const quarterlyPrice = service.quarterly_price ? parseFloat(service.quarterly_price) : null;
      const quantity = parseInt(service.quantity) || 1;
      const contractMonths = parseInt(service.contract_months) || 12;
      const contractQuarters = parseInt(service.contract_quarters) || 4;
      const commissionRate = service.commission_rate ? parseFloat(service.commission_rate) : null;

      if (service.billing_type === 'mrr' && !monthlyPrice) {
        return { commissionable_value: 0, commission_amount: 0 };
      }

      if (service.billing_type === 'quarterly' && !quarterlyPrice) {
        return { commissionable_value: 0, commission_amount: 0 };
      }

      const result = calculateServiceCommission(
        service.billing_type,
        unitPrice,
        monthlyPrice,
        quarterlyPrice,
        quantity,
        contractMonths,
        contractQuarters,
        commissionRate,
        baseCommissionRate
      );

      return result;
    } catch (err) {
      return { commissionable_value: 0, commission_amount: 0 };
    }
  };

  // Update service and recalculate commission
  const updateService = (index: number, field: keyof ServiceFormData, value: string) => {
    const updatedServices = [...services];
    updatedServices[index] = { ...updatedServices[index], [field]: value };
    
    // Recalculate commission for this service
    const commission = calculateServiceCommissionValue(updatedServices[index]);
    updatedServices[index].commissionable_value = commission.commissionable_value;
    updatedServices[index].commission_amount = commission.commission_amount;
    
    setServices(updatedServices);
  };

  const addService = () => {
    setServices([...services, {
      service_name: '',
      billing_type: 'one_off',
      unit_price: '',
      monthly_price: '',
      quarterly_price: '',
      quantity: '1',
      contract_months: '12',
      contract_quarters: '4',
      commission_rate: '',
      completion_date: '',
    }]);
  };

  const removeService = (index: number) => {
    if (services.length > 1) {
      setServices(services.filter((_, i) => i !== index));
    }
  };

  const totalCommission = services.reduce((sum, service) => {
    return sum + (service.commission_amount || 0);
  }, 0);

  // Calculate renewal commission if this is a renewal
  const renewalCommission = formData.is_renewal
    ? (() => {
        let originalValue = 0;
        
        if (formData.use_manual_original_value && formData.original_deal_value) {
          // Use manually entered value
          originalValue = parseFloat(formData.original_deal_value) || 0;
        } else if (formData.original_deal_id) {
          // Use value from selected original deal
          const originalDeal = originalDeals.find(d => d.id === formData.original_deal_id);
          if (originalDeal?.deal_value) {
            originalValue = originalDeal.deal_value;
          }
        }
        
        if (originalValue > 0) {
          const renewalValue = services.reduce((sum, service) => {
            return sum + (service.commissionable_value || 0);
          }, 0);
          const uplift = renewalValue - originalValue;
          return uplift > 0 ? uplift * 0.025 : 0; // 2.5% on uplift
        }
        
        return null;
      })()
    : null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    // Prevent duplicate submissions
    if (loading) {
      return;
    }
    
    setLoading(true);
    setError('');

    // Validate service_type if not using services (legacy mode)
    if (formData.use_legacy_mode) {
      if (!formData.service_type || formData.service_type.trim() === '') {
        setError('Service type is required when not using services');
        setLoading(false);
        return;
      }
    }

    // Validate services (unless in legacy mode)
    const validServices = formData.use_legacy_mode ? [] : services.map(service => {
      const unitPrice = parseFloat(service.unit_price) || 0;
      const monthlyPrice = service.monthly_price ? parseFloat(service.monthly_price) : null;
      const quarterlyPrice = service.quarterly_price ? parseFloat(service.quarterly_price) : null;
      const quantity = parseInt(service.quantity) || 1;
      const contractMonths = parseInt(service.contract_months) || 12;
      const contractQuarters = parseInt(service.contract_quarters) || 4;
      const commissionRate = service.commission_rate ? parseFloat(service.commission_rate) : null;

      if (!service.service_name.trim()) {
        throw new Error('All services must have a name');
      }

      // Validate pricing based on billing type
      if (service.billing_type === 'mrr') {
        if (!monthlyPrice || isNaN(monthlyPrice) || monthlyPrice <= 0) {
          throw new Error('MRR services must have a valid monthly price');
        }
      } else if (service.billing_type === 'quarterly') {
        if (!quarterlyPrice || isNaN(quarterlyPrice) || quarterlyPrice <= 0) {
          throw new Error('Quarterly services must have a valid quarterly price');
        }
      } else {
        // For one_off and deposit, unit_price is required
        if (isNaN(unitPrice) || unitPrice <= 0) {
          throw new Error('All services must have a valid unit price');
        }
      }

      const commission = calculateServiceCommission(
        service.billing_type,
        unitPrice,
        monthlyPrice,
        quarterlyPrice,
        quantity,
        contractMonths,
        contractQuarters,
        commissionRate,
        baseCommissionRate
      );

      return {
        ...(service.id && { id: service.id }),
        service_name: service.service_name.trim(),
        billing_type: service.billing_type,
        // Always include unit_price (default to 0 for MRR/quarterly since DB requires NOT NULL)
        unit_price: (service.billing_type === 'one_off' || service.billing_type === 'deposit') ? unitPrice : 0,
        monthly_price: monthlyPrice,
        quarterly_price: quarterlyPrice,
        quantity,
        contract_months: contractMonths,
        contract_quarters: contractQuarters,
        commission_rate: commissionRate,
        commissionable_value: commission.commissionable_value,
        commission_amount: commission.commission_amount,
        completion_date: service.completion_date || null,
      };
    });

    try {
      const url = dealId ? `/api/deals/${dealId}` : '/api/deals';
      const method = dealId ? 'PATCH' : 'POST';

      // Calculate deal_value
      let dealValue: number;
      if (formData.use_legacy_mode) {
        // In legacy mode, get deal_value from the legacy_deal_value field
        const legacyValue = (formData as any).legacy_deal_value;
        if (!legacyValue || parseFloat(legacyValue) <= 0) {
          setError('Deal value is required in legacy mode and must be greater than 0');
          setLoading(false);
          return;
        }
        dealValue = parseFloat(legacyValue);
      } else {
        // Calculate deal_value from services (sum of commissionable_value)
        if (validServices.length === 0) {
          setError('At least one service is required when not using legacy mode');
          setLoading(false);
          return;
        }
        dealValue = validServices.reduce((sum, service) => {
          return sum + (service.commissionable_value || 0);
        }, 0);
      }

      // Derive service_type from first service if not provided and services exist
      let serviceType = formData.service_type;
      if (!serviceType && validServices.length > 0) {
        // Use first service name as service_type if not provided
        serviceType = validServices[0].service_name;
      }

      // Validate service_type is present
      if (!serviceType || serviceType.trim() === '') {
        setError('Service type is required');
        setLoading(false);
        return;
      }

      const submitData: any = {
        ...formData,
        service_type: serviceType.trim(),
        deal_value: dealValue,
        payout_months: parseInt(formData.payout_months.toString(), 10),
        services: formData.use_legacy_mode ? undefined : validServices,
      };

      // Convert empty strings to null for optional UUID fields
      if (submitData.client_id === '') {
        submitData.client_id = null;
      }
      if (submitData.original_deal_id === '') {
        submitData.original_deal_id = null;
      }

      // Include original_deal_value if manually entered, otherwise remove it
      if (formData.use_manual_original_value && formData.original_deal_value) {
        submitData.original_deal_value = parseFloat(formData.original_deal_value);
      } else {
        submitData.original_deal_value = null;
      }

      // Clear original_deal_id if using manual value
      if (formData.use_manual_original_value) {
        submitData.original_deal_id = null;
      }

      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(submitData),
      });

      if (!res.ok) {
        const errorData = await res.json();
        throw new Error(errorData.error || 'Failed to save deal');
      }

      router.push('/deals');
      router.refresh();
    } catch (err: any) {
      setError(err.message);
      setLoading(false);
    }
  };

  const formatCurrency = (value: number) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value);
  };

  return (
    <>
      <form onSubmit={handleSubmit} className="space-y-6">
        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded">
            {error}
          </div>
        )}

        {/* Deal Basic Info */}
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
        <div>
          <label htmlFor="bdr_id" className="block text-sm font-medium text-gray-700">
            BDR Rep
          </label>
          <select
            id="bdr_id"
            required
            value={formData.bdr_id}
            onChange={(e) => setFormData({ ...formData, bdr_id: e.target.value })}
            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
          >
            <option value="">Select BDR</option>
            {bdrReps.map((rep) => (
              <option key={rep.id} value={rep.id}>
                {rep.name} ({rep.email})
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="client_id" className="block text-sm font-medium text-gray-700">
            Client
          </label>
          <div className="mt-1 flex gap-2">
            <select
              id="client_id"
              required
              value={formData.client_id}
              onChange={(e) => {
                const selectedClient = clients.find(c => c.id === e.target.value);
                setFormData({ 
                  ...formData, 
                  client_id: e.target.value,
                  client_name: selectedClient?.name || '',
                });
                // Update original deals when client changes and it's a renewal
                if (formData.is_renewal && selectedClient) {
                  fetch(`/api/deals?client_name=${encodeURIComponent(selectedClient.name)}`)
                    .then(res => res.json())
                    .then(data => {
                      const filtered = Array.isArray(data) 
                        ? data.filter((d: any) => d.id !== dealId && d.status === 'closed-won')
                        : [];
                      setOriginalDeals(filtered);
                    })
                    .catch(err => console.error('Failed to fetch original deals:', err));
                }
              }}
              className="flex-1 rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
            >
              <option value="">Select Client...</option>
              {clients.map((client) => (
                <option key={client.id} value={client.id}>
                  {client.name} {client.company ? `(${client.company})` : ''}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => setShowClientModal(true)}
              className="inline-flex items-center px-3 py-2 border border-gray-300 rounded-md shadow-sm text-sm font-medium text-gray-700 bg-white hover:bg-gray-50"
            >
              + New
            </button>
          </div>
          {formData.client_id && (
            <p className="mt-1 text-xs text-gray-500">
              Selected: {clients.find(c => c.id === formData.client_id)?.name}
            </p>
          )}
        </div>

        <div>
          <label htmlFor="service_type" className="block text-sm font-medium text-gray-700">
            Service Type
          </label>
          <input
            type="text"
            id="service_type"
            value={formData.service_type}
            onChange={(e) => setFormData({ ...formData, service_type: e.target.value })}
            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
            placeholder="e.g., Bookkeeping, Tax Filing, Consulting"
          />
          <p className="mt-1 text-xs text-gray-500">
            General service category for this deal
          </p>
        </div>

        <div>
          <label htmlFor="proposal_date" className="block text-sm font-medium text-gray-700">
            Proposal Date
          </label>
          <input
            type="date"
            id="proposal_date"
            required
            value={formData.proposal_date}
            onChange={(e) => setFormData({ ...formData, proposal_date: e.target.value })}
            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
          />
        </div>

        <div>
          <label htmlFor="close_date" className="block text-sm font-medium text-gray-700">
            Close Date
          </label>
          <input
            type="date"
            id="close_date"
            value={formData.close_date}
            onChange={(e) => setFormData({ ...formData, close_date: e.target.value })}
            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
          />
        </div>

        <div>
          <label htmlFor="first_invoice_date" className="block text-sm font-medium text-gray-700">
            First Invoice Date
          </label>
          <input
            type="date"
            id="first_invoice_date"
            value={formData.first_invoice_date}
            onChange={(e) => setFormData({ ...formData, first_invoice_date: e.target.value })}
            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
          />
        </div>

        <div>
          <label htmlFor="status" className="block text-sm font-medium text-gray-700">
            Status
          </label>
          <select
            id="status"
            required
            value={formData.status}
            onChange={(e) => setFormData({ ...formData, status: e.target.value })}
            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
          >
            <option value="proposed">Proposed</option>
            <option value="closed-won">Closed-Won</option>
            <option value="closed-lost">Closed-Lost</option>
          </select>
        </div>

        <div>
          <label htmlFor="payout_months" className="block text-sm font-medium text-gray-700">
            Payout Months
          </label>
          <input
            type="number"
            id="payout_months"
            required
            min="1"
            max="60"
            value={formData.payout_months}
            onChange={(e) => setFormData({ ...formData, payout_months: parseInt(e.target.value) || 12 })}
            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
          />
        </div>

        <div className="sm:col-span-2">
          <label className="flex items-center">
            <input
              type="checkbox"
              checked={formData.is_renewal}
              onChange={(e) => {
                setFormData({ 
                  ...formData, 
                  is_renewal: e.target.checked,
                  original_deal_id: e.target.checked ? formData.original_deal_id : '',
                });
                // Fetch original deals when renewal is checked
                if (e.target.checked && formData.client_name) {
                  fetch(`/api/deals?client_name=${encodeURIComponent(formData.client_name)}`)
                    .then(res => res.json())
                    .then(data => {
                      const filtered = Array.isArray(data) 
                        ? data.filter((d: any) => d.id !== dealId && d.status === 'closed-won')
                        : [];
                      setOriginalDeals(filtered);
                    })
                    .catch(err => console.error('Failed to fetch original deals:', err));
                }
              }}
              className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
            />
            <span className="ml-2 text-sm text-gray-700">This is a renewal</span>
          </label>
        </div>

        {formData.is_renewal && (
          <div className="sm:col-span-2 space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Original Deal Information
              </label>
              <div className="flex gap-4 mb-3">
                <label className="flex items-center">
                  <input
                    type="radio"
                    name="original_deal_method"
                    checked={!formData.use_manual_original_value}
                    onChange={() => setFormData({ ...formData, use_manual_original_value: false, original_deal_value: '' })}
                    className="mr-2 text-indigo-600 focus:ring-indigo-500"
                  />
                  <span className="text-sm text-gray-700">Select from existing deals</span>
                </label>
                <label className="flex items-center">
                  <input
                    type="radio"
                    name="original_deal_method"
                    checked={formData.use_manual_original_value}
                    onChange={() => setFormData({ ...formData, use_manual_original_value: true, original_deal_id: '' })}
                    className="mr-2 text-indigo-600 focus:ring-indigo-500"
                  />
                  <span className="text-sm text-gray-700">Enter value manually</span>
                </label>
              </div>
            </div>

            {!formData.use_manual_original_value ? (
              <div>
                <label htmlFor="original_deal_id" className="block text-sm font-medium text-gray-700">
                  Original Deal
                </label>
                <select
                  id="original_deal_id"
                  value={formData.original_deal_id}
                  onChange={(e) => setFormData({ ...formData, original_deal_id: e.target.value })}
                  className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
                >
                  <option value="">Select original deal...</option>
                  {originalDeals.map((deal) => (
                    <option key={deal.id} value={deal.id}>
                      {deal.client_name} - ${deal.deal_value?.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ({new Date(deal.close_date || deal.proposal_date).toLocaleDateString()})
                    </option>
                  ))}
                </select>
                <p className="mt-1 text-xs text-gray-500">
                  Select the original deal this renewal is based on. Commission will be calculated on the uplift (increase) amount at 2.5%.
                </p>
                {originalDeals.length === 0 && formData.client_name && (
                  <p className="mt-1 text-xs text-yellow-600">
                    No closed-won deals found for this client. You can enter the original deal value manually instead.
                  </p>
                )}
              </div>
            ) : (
              <div>
                <label htmlFor="original_deal_value" className="block text-sm font-medium text-gray-700">
                  Original Deal Value ($)
                </label>
                <input
                  type="number"
                  id="original_deal_value"
                  step="0.01"
                  min="0"
                  value={formData.original_deal_value}
                  onChange={(e) => setFormData({ ...formData, original_deal_value: e.target.value })}
                  className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
                  placeholder="Enter the original deal value"
                />
                <p className="mt-1 text-xs text-gray-500">
                  Enter the total value of the original deal. Commission will be calculated on the uplift (increase) amount at 2.5%.
                </p>
                {renewalCommission !== null && (
                  <div className="mt-2 p-3 bg-blue-50 rounded border border-blue-200">
                    <p className="text-xs text-gray-600 mb-1">Renewal Commission Preview:</p>
                    <p className="text-sm font-semibold text-blue-900">
                      {formatCurrency(renewalCommission)}
                    </p>
                    <p className="text-xs text-gray-500 mt-1">
                      Based on uplift: {formatCurrency(
                        services.reduce((sum, s) => sum + (s.commissionable_value || 0), 0) - (parseFloat(formData.original_deal_value) || 0)
                      )}
                    </p>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
        </div>

        {/* Legacy Mode Toggle */}
        <div className="border-t border-gray-200 pt-6">
          <label className="flex items-center">
            <input
              type="checkbox"
              checked={formData.use_legacy_mode}
              onChange={(e) => setFormData({ ...formData, use_legacy_mode: e.target.checked })}
              className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
            />
            <span className="ml-2 text-sm text-gray-700">Use legacy mode (no services - enter deal value directly)</span>
          </label>
          {formData.use_legacy_mode && (
            <div className="mt-4 p-4 bg-yellow-50 border border-yellow-200 rounded-lg">
              <p className="text-sm text-yellow-800 mb-4">
                <strong>Legacy Mode:</strong> In this mode, you&apos;ll enter the deal value directly instead of using services. 
                Service type is required. Commission will be calculated using the base rate from commission rules.
              </p>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <label htmlFor="legacy_deal_value" className="block text-sm font-medium text-gray-700">
                    Deal Value ($) *
                  </label>
                  <input
                    type="number"
                    id="legacy_deal_value"
                    step="0.01"
                    min="0"
                    required={formData.use_legacy_mode}
                    value={(formData as any).legacy_deal_value || ''}
                    onChange={(e) => {
                      // Store legacy deal value in formData
                      setFormData({ ...formData, legacy_deal_value: e.target.value } as any);
                    }}
                    className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
                    placeholder="Enter total deal value"
                  />
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Services Section */}
        {!formData.use_legacy_mode && (
        <>
        <div className="border-t border-gray-200 pt-6">
          <div className="flex justify-between items-center mb-4">
          <h3 className="text-lg font-medium text-gray-900">Services</h3>
          <button
            type="button"
            onClick={addService}
            className="inline-flex items-center px-3 py-2 border border-gray-300 shadow-sm text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50"
          >
            + Add Service
          </button>
        </div>

        <div className="space-y-6">
          {services.map((service, index) => (
            <div key={index} className="bg-gray-50 p-4 rounded-lg border border-gray-200">
              <div className="flex justify-between items-start mb-4">
                <h4 className="text-base font-medium text-gray-900">Service {index + 1}</h4>
                {services.length > 1 && (
                  <button
                    type="button"
                    onClick={() => removeService(index)}
                    className="text-sm text-red-600 hover:text-red-800"
                  >
                    Remove
                  </button>
                )}
              </div>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="sm:col-span-2">
                  <label className="block text-sm font-medium text-gray-700">
                    Service Name
                  </label>
                  <input
                    type="text"
                    required
                    value={service.service_name}
                    onChange={(e) => updateService(index, 'service_name', e.target.value)}
                    className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
                    placeholder="e.g., Bookkeeping, Tax Filing"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700">
                    Billing Type
                  </label>
                  <select
                    required
                    value={service.billing_type}
                    onChange={(e) => updateService(index, 'billing_type', e.target.value)}
                    className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
                  >
                    <option value="one_off">Once-Off Payment</option>
                    <option value="mrr">Monthly Recurring Revenue (MRR)</option>
                    <option value="quarterly">Recurring Quarterly</option>
                    <option value="deposit">Deposit-Based (50% / 50%)</option>
                  </select>
                </div>

                {service.billing_type === 'mrr' ? (
                  <>
                    <div>
                      <label className="block text-sm font-medium text-gray-700">
                        Monthly Price ($)
                      </label>
                      <input
                        type="number"
                        required
                        step="0.01"
                        min="0"
                        value={service.monthly_price}
                        onChange={(e) => updateService(index, 'monthly_price', e.target.value)}
                        className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700">
                        Contract Months
                      </label>
                      <input
                        type="number"
                        required
                        min="1"
                        max="120"
                        value={service.contract_months}
                        onChange={(e) => updateService(index, 'contract_months', e.target.value)}
                        className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700">
                        Quantity
                      </label>
                      <input
                        type="number"
                        required
                        min="1"
                        value={service.quantity}
                        onChange={(e) => updateService(index, 'quantity', e.target.value)}
                        className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
                      />
                    </div>
                  </>
                ) : service.billing_type === 'quarterly' ? (
                  <>
                    <div>
                      <label className="block text-sm font-medium text-gray-700">
                        Quarterly Price ($)
                      </label>
                      <input
                        type="number"
                        required
                        step="0.01"
                        min="0"
                        value={service.quarterly_price}
                        onChange={(e) => updateService(index, 'quarterly_price', e.target.value)}
                        className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700">
                        Contract Quarters
                      </label>
                      <input
                        type="number"
                        required
                        min="1"
                        max="40"
                        value={service.contract_quarters}
                        onChange={(e) => updateService(index, 'contract_quarters', e.target.value)}
                        className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700">
                        Quantity
                      </label>
                      <input
                        type="number"
                        required
                        min="1"
                        value={service.quantity}
                        onChange={(e) => updateService(index, 'quantity', e.target.value)}
                        className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
                      />
                    </div>
                  </>
                ) : (
                  <>
                    <div>
                      <label className="block text-sm font-medium text-gray-700">
                        Unit Price ($)
                      </label>
                      <input
                        type="number"
                        required
                        step="0.01"
                        min="0"
                        value={service.unit_price}
                        onChange={(e) => updateService(index, 'unit_price', e.target.value)}
                        className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700">
                        Quantity
                      </label>
                      <input
                        type="number"
                        required
                        min="1"
                        value={service.quantity}
                        onChange={(e) => updateService(index, 'quantity', e.target.value)}
                        className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
                      />
                    </div>
                    {service.billing_type === 'deposit' && (
                      <div>
                        <label className="block text-sm font-medium text-gray-700">
                          Completion Date (50% Due Date)
                        </label>
                        <input
                          type="date"
                          value={service.completion_date || ''}
                          onChange={(e) => updateService(index, 'completion_date', e.target.value)}
                          className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
                        />
                        <p className="mt-1 text-xs text-gray-500">
                          Date when the second 50% payment is due. Commission will be split: 50% on acceptance, 50% on this date.
                        </p>
                      </div>
                    )}
                  </>
                )}

                <div>
                  <label className="block text-sm font-medium text-gray-700">
                    Commission Rate (optional, defaults to {baseCommissionRate * 100}%)
                  </label>
                  <input
                    type="number"
                    step="0.0001"
                    min="0"
                    max="1"
                    value={service.commission_rate}
                    onChange={(e) => updateService(index, 'commission_rate', e.target.value)}
                    className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
                    placeholder="e.g., 0.05 for 5%"
                  />
                </div>

                <div className="sm:col-span-2 bg-white p-3 rounded border border-gray-200">
                  <div className="flex justify-between items-center">
                    <div>
                      <p className="text-sm text-gray-500">Commissionable Value</p>
                      <p className="text-base font-semibold text-gray-900">
                        {formatCurrency(service.commissionable_value || 0)}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-sm text-gray-500">Commission</p>
                      <p className="text-base font-semibold text-indigo-600">
                        {formatCurrency(service.commission_amount || 0)}
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Total Commission Summary */}
        <div className="mt-6 bg-indigo-50 p-4 rounded-lg border border-indigo-200">
          <div className="flex justify-between items-center">
            <span className="text-base font-medium text-gray-900">
              {formData.is_renewal && (formData.use_manual_original_value || formData.original_deal_id)
                ? 'Renewal Commission (on uplift):'
                : 'Total Deal Commission:'}
            </span>
            <span className="text-xl font-bold text-indigo-600">
              {formData.is_renewal && renewalCommission !== null
                ? formatCurrency(renewalCommission)
                : formatCurrency(totalCommission)}
            </span>
          </div>
          {formData.is_renewal && renewalCommission !== null && (
            <p className="mt-2 text-xs text-gray-600">
              Based on 2.5% of uplift amount
            </p>
          )}
        </div>
        </div>
        </>
        )}

        <div className="flex justify-end space-x-3">
          <button
            type="button"
            onClick={() => router.back()}
            className="px-4 py-2 border border-gray-300 rounded-md shadow-sm text-sm font-medium text-gray-700 bg-white hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={loading}
            className="px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50"
          >
            {loading ? 'Saving...' : dealId ? 'Update Deal' : 'Create Deal'}
          </button>
        </div>
      </form>

      {/* Client Creation Modal */}
      {showClientModal && (
        <div className="fixed inset-0 z-50 overflow-y-auto" aria-labelledby="modal-title" role="dialog" aria-modal="true">
          {/* Backdrop */}
          <div 
            className="fixed inset-0 bg-gray-500 bg-opacity-75 transition-opacity"
            onClick={() => setShowClientModal(false)}
          ></div>

          {/* Modal Container */}
          <div className="flex min-h-full items-end justify-center p-4 text-center sm:items-center sm:p-0">
            <div className="relative transform overflow-hidden rounded-lg bg-white text-left shadow-xl transition-all sm:my-8 sm:w-full sm:max-w-lg">
              {/* Modal Header */}
              <div className="bg-white px-4 pt-5 pb-4 sm:p-6 sm:pb-4">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-lg font-medium leading-6 text-gray-900" id="modal-title">
                    Add New Client
                  </h3>
                  <button
                    type="button"
                    onClick={() => setShowClientModal(false)}
                    className="text-gray-400 hover:text-gray-500 focus:outline-none"
                  >
                    <span className="sr-only">Close</span>
                    <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
                {/* Client Form */}
                <ClientFormModal 
                  onSuccess={handleClientCreated}
                  onCancel={() => setShowClientModal(false)}
                />
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// Modal wrapper for ClientForm
function ClientFormModal({ onSuccess, onCancel }: { onSuccess: (clientId: string) => void; onCancel: () => void }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [name, setName] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      const trimmedName = name.trim();
      if (!trimmedName) {
        throw new Error('Company name is required');
      }

      const res = await fetch('/api/clients', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          name: trimmedName
        }),
      });

      if (!res.ok) {
        const errorData = await res.json();
        const errorMessage = errorData.error || 'Failed to save client';
        console.error('Client creation error:', errorMessage, errorData);
        throw new Error(errorMessage);
      }

      const newClient = await res.json();
      onSuccess(newClient.id);
    } catch (err: any) {
      setError(err.message);
      setLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded">
          {error}
        </div>
      )}

      <div>
        <label htmlFor="modal-name" className="block text-sm font-medium text-gray-700">
          Company Name *
        </label>
        <input
          type="text"
          id="modal-name"
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
          placeholder="Enter company name"
          autoFocus
        />
      </div>

      <div className="flex justify-end space-x-3 pt-4 border-t border-gray-200">
        <button
          type="button"
          onClick={onCancel}
          className="px-4 py-2 border border-gray-300 rounded-md shadow-sm text-sm font-medium text-gray-700 bg-white hover:bg-gray-50"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={loading || !name.trim()}
          className="px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50"
        >
          {loading ? 'Creating...' : 'Create Client'}
        </button>
      </div>
    </form>
  );
}
