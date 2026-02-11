'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { ServiceForm } from './ServiceForm';
import { calculateServiceCommission, calculateDealTotalCommission } from '@/lib/commission/calculator';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Trash2, Edit2, Plus } from 'lucide-react';

interface DealFormProps {
  dealId?: string;
  initialData?: any;
  baseCommissionRate?: number;
}

interface Client {
  id: string;
  name: string;
  company?: string;
}

interface BDRRep {
  id: string;
  name: string;
  email: string;
}

export function DealForm({ dealId, initialData, baseCommissionRate: propBaseRate }: DealFormProps) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [baseCommissionRate, setBaseCommissionRate] = useState(propBaseRate || 0.025);
  const [clients, setClients] = useState<Client[]>([]);
  const [bdrReps, setBdrReps] = useState<BDRRep[]>([]);
  const [isAdmin, setIsAdmin] = useState(false);
  const [editingServiceId, setEditingServiceId] = useState<string | null>(null);
  const [addingService, setAddingService] = useState(false);

  const [formData, setFormData] = useState({
    client_id: initialData?.client_id || '',
    client_name: initialData?.client_name || '',
    bdr_id: initialData?.bdr_id || '',
    proposal_date: initialData?.proposal_date ? initialData.proposal_date.split('T')[0] : new Date().toISOString().split('T')[0],
    close_date: initialData?.close_date ? initialData.close_date.split('T')[0] : '',
    first_invoice_date: initialData?.first_invoice_date ? initialData.first_invoice_date.split('T')[0] : '',
    deal_value: initialData?.deal_value || 0,
    status: initialData?.status || 'proposed',
    is_renewal: initialData?.is_renewal || false,
    payout_months: initialData?.payout_months || 12,
    cancellation_date: initialData?.cancellation_date ? initialData.cancellation_date.split('T')[0] : '',
    do_not_pay_future: initialData?.do_not_pay_future || false,
    original_deal_value: initialData?.original_deal_value || null,
    original_deal_id: initialData?.original_deal_id || '',
  });

  const [services, setServices] = useState<any[]>(initialData?.deal_services || []);

  useEffect(() => {
    // Fetch base commission rate
    const fetchRate = async () => {
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

    // Fetch clients
    const fetchClients = async () => {
      try {
        const res = await fetch('/api/clients?limit=1000');
        if (res.ok) {
          const data = await res.json();
          setClients(Array.isArray(data) ? data : (data.data || []));
        }
      } catch (err) {
        console.error('Failed to fetch clients:', err);
      }
    };

    // Fetch BDR reps and check admin status
    const fetchBdrReps = async () => {
      try {
        const res = await fetch('/api/bdr-reps');
        if (res.ok) {
          const data = await res.json();
          setBdrReps(Array.isArray(data) ? data : []);
        }
      } catch (err) {
        console.error('Failed to fetch BDR reps:', err);
      }
    };

    // Check if user is admin
    const checkAdmin = async () => {
      try {
        const res = await fetch('/api/auth/user');
        if (res.ok) {
          const data = await res.json();
          setIsAdmin(data.role === 'admin');
        }
      } catch (err) {
        console.error('Failed to check admin status:', err);
      }
    };

    fetchRate();
    fetchClients();
    fetchBdrReps();
    checkAdmin();
  }, []);

  // Recalculate deal value when services change
  useEffect(() => {
    if (services.length > 0) {
      const totalValue = services.reduce((sum, s) => sum + (s.commissionable_value || 0), 0);
      setFormData(prev => ({ ...prev, deal_value: totalValue }));
    }
  }, [services]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      const url = dealId ? `/api/deals/${dealId}` : '/api/deals';
      const method = dealId ? 'PATCH' : 'POST';

      const response = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          ...formData,
          deal_value: parseFloat(formData.deal_value.toString()),
          payout_months: parseInt(formData.payout_months.toString()),
          is_renewal: formData.is_renewal,
          do_not_pay_future: formData.do_not_pay_future,
          cancellation_date: formData.cancellation_date || null,
          original_deal_value: formData.original_deal_value ? parseFloat(formData.original_deal_value.toString()) : null,
          original_deal_id: formData.original_deal_id || null,
        }),
      });

      const { safeJsonParse } = await import('@/lib/utils/client-helpers');
      const data = await safeJsonParse(response);

      if (!response.ok || data.error) {
        throw new Error(data.error || 'Failed to save deal');
      }

      router.push(`/deals${dealId ? `/${dealId}` : ''}`);
      router.refresh();
    } catch (err: any) {
      setError(err.message || 'Failed to save deal');
    } finally {
      setLoading(false);
    }
  };

  const handleAddService = async (serviceData: any) => {
    if (!dealId) {
      // For new deals, just add to local state
      const calc = calculateServiceCommission(
        serviceData.billing_type,
        serviceData.unit_price,
        serviceData.monthly_price || null,
        serviceData.quarterly_price || null,
        serviceData.quantity,
        serviceData.contract_months,
        serviceData.contract_quarters,
        serviceData.commission_rate || null,
        baseCommissionRate
      );
      // Generate a temporary ID for new services
      const tempId = `temp-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      setServices([...services, { ...serviceData, ...calc, id: tempId }]);
      setAddingService(false);
      return;
    }

    try {
      const res = await fetch(`/api/deals/${dealId}/services`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(serviceData),
      });

      const data = await res.json();
      if (!res.ok || data.error) {
        throw new Error(data.error || 'Failed to add service');
      }

      setServices([...services, data]);
      setAddingService(false);
    } catch (err: any) {
      setError(err.message || 'Failed to add service');
    }
  };

  const handleUpdateService = async (serviceData: any) => {
    if (!dealId || !serviceData.id) {
      // For new deals, update in local state
      setServices(services.map(s => s.id === serviceData.id ? serviceData : s));
      setEditingServiceId(null);
      return;
    }

    try {
      const res = await fetch(`/api/deals/${dealId}/services/${serviceData.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(serviceData),
      });

      const data = await res.json();
      if (!res.ok || data.error) {
        throw new Error(data.error || 'Failed to update service');
      }

      setServices(services.map(s => s.id === serviceData.id ? data : s));
      setEditingServiceId(null);
    } catch (err: any) {
      setError(err.message || 'Failed to update service');
    }
  };

  const handleDeleteService = async (serviceId: string) => {
    if (!confirm('Are you sure you want to delete this service?')) {
      return;
    }

    if (!dealId) {
      // For new deals, just remove from local state
      setServices(services.filter(s => s.id !== serviceId));
      return;
    }

    try {
      const res = await fetch(`/api/deals/${dealId}/services/${serviceId}`, {
        method: 'DELETE',
        credentials: 'include',
      });

      const data = await res.json();
      if (!res.ok || data.error) {
        throw new Error(data.error || 'Failed to delete service');
      }

      setServices(services.filter(s => s.id !== serviceId));
    } catch (err: any) {
      setError(err.message || 'Failed to delete service');
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

  const getBillingTypeLabel = (type: string) => {
    switch (type) {
      case 'one_off': return 'Once-Off Payment';
      case 'mrr': return 'Monthly Recurring Revenue (MRR)';
      case 'quarterly': return 'Recurring Quarterly';
      case 'deposit': return 'Deposit-Based Billing (50% / 50%)';
      default: return type;
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-800 px-4 py-3 rounded">
          {error}
        </div>
      )}

      {/* Basic Deal Information */}
      <Card>
        <CardHeader>
          <CardTitle>Deal Information</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label htmlFor="client_name">Client Name *</Label>
            <Input
              id="client_name"
              value={formData.client_name}
              onChange={(e) => setFormData({ ...formData, client_name: e.target.value })}
              required
            />
          </div>

          {clients.length > 0 && (
            <div>
              <Label htmlFor="client_id">Link to Client (optional)</Label>
              <Select
                value={formData.client_id || 'none'}
                onValueChange={(value) => {
                  if (value === 'none') {
                    setFormData({
                      ...formData,
                      client_id: '',
                    });
                  } else {
                    const client = clients.find(c => c.id === value);
                    setFormData({
                      ...formData,
                      client_id: value,
                      client_name: client?.name || formData.client_name,
                    });
                  }
                }}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select a client" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">None</SelectItem>
                  {clients.map((client) => (
                    <SelectItem key={client.id} value={client.id}>
                      {client.name} {client.company && `(${client.company})`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {isAdmin && bdrReps.length > 0 && (
            <div>
              <Label htmlFor="bdr_id">BDR Rep</Label>
              <Select
                value={formData.bdr_id}
                onValueChange={(value) => setFormData({ ...formData, bdr_id: value })}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select BDR rep" />
                </SelectTrigger>
                <SelectContent>
                  {bdrReps.map((rep) => (
                    <SelectItem key={rep.id} value={rep.id}>
                      {rep.name} ({rep.email})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}


          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <Label htmlFor="proposal_date">Proposal Date *</Label>
              <Input
                id="proposal_date"
                type="date"
                value={formData.proposal_date}
                onChange={(e) => setFormData({ ...formData, proposal_date: e.target.value })}
                required
              />
            </div>

            <div>
              <Label htmlFor="close_date">Close Date</Label>
              <Input
                id="close_date"
                type="date"
                value={formData.close_date}
                onChange={(e) => {
                  const newCloseDate = e.target.value;
                  let newFirstInvoiceDate = formData.first_invoice_date;
                  if (newCloseDate) {
                    const closeDateObj = new Date(newCloseDate);
                    const calculatedDate = new Date(closeDateObj);
                    calculatedDate.setDate(calculatedDate.getDate() + 7);
                    newFirstInvoiceDate = calculatedDate.toISOString().split('T')[0];
                  }
                  setFormData({
                    ...formData,
                    close_date: newCloseDate,
                    first_invoice_date: newFirstInvoiceDate,
                  });
                }}
              />
            </div>

            <div>
              <Label htmlFor="first_invoice_date">First Invoice Date</Label>
              <Input
                id="first_invoice_date"
                type="date"
                value={formData.first_invoice_date}
                onChange={(e) => setFormData({ ...formData, first_invoice_date: e.target.value })}
              />
              {formData.close_date && (
                <p className="text-xs text-muted-foreground mt-1">
                  Auto-calculated from close date (close_date + 7 days). You can override if needed.
                </p>
              )}
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <Label htmlFor="status">Status *</Label>
              <Select
                value={formData.status}
                onValueChange={(value) => setFormData({ ...formData, status: value })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="proposed">Proposed</SelectItem>
                  <SelectItem value="closed-won">Closed Won</SelectItem>
                  <SelectItem value="closed-lost">Closed Lost</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div>
              <Label htmlFor="payout_months">Payout Months</Label>
              <Input
                id="payout_months"
                type="number"
                value={formData.payout_months}
                onChange={(e) => setFormData({ ...formData, payout_months: e.target.value })}
                min="1"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <Label htmlFor="deal_value">Deal Value</Label>
              <Input
                id="deal_value"
                type="number"
                step="0.01"
                value={formData.deal_value}
                onChange={(e) => setFormData({ ...formData, deal_value: e.target.value })}
                readOnly={services.length > 0}
              />
              {services.length > 0 && (
                <p className="text-xs text-muted-foreground mt-1">
                  Auto-calculated from services
                </p>
              )}
            </div>

            {formData.original_deal_value !== null && (
              <div>
                <Label htmlFor="original_deal_value">Original Deal Value</Label>
                <Input
                  id="original_deal_value"
                  type="number"
                  step="0.01"
                  value={formData.original_deal_value || ''}
                  onChange={(e) => setFormData({ ...formData, original_deal_value: e.target.value ? parseFloat(e.target.value) : null })}
                />
              </div>
            )}
          </div>

          <div className="flex items-center space-x-2">
            <input
              type="checkbox"
              id="is_renewal"
              checked={formData.is_renewal}
              onChange={(e) => setFormData({ ...formData, is_renewal: e.target.checked })}
              className="rounded"
            />
            <Label htmlFor="is_renewal">Is Renewal</Label>
          </div>

          <div className="flex items-center space-x-2">
            <input
              type="checkbox"
              id="do_not_pay_future"
              checked={formData.do_not_pay_future}
              onChange={(e) => setFormData({ ...formData, do_not_pay_future: e.target.checked })}
              className="rounded"
            />
            <Label htmlFor="do_not_pay_future">Do Not Pay Future</Label>
          </div>

          {formData.cancellation_date && (
            <div>
              <Label htmlFor="cancellation_date">Cancellation Date</Label>
              <Input
                id="cancellation_date"
                type="date"
                value={formData.cancellation_date}
                onChange={(e) => setFormData({ ...formData, cancellation_date: e.target.value })}
              />
            </div>
          )}
        </CardContent>
      </Card>

      {/* Services Section */}
      <Card>
        <CardHeader>
          <div className="flex justify-between items-center">
            <CardTitle>Services</CardTitle>
            {!addingService && !editingServiceId && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setAddingService(true)}
              >
                <Plus className="h-4 w-4 mr-2" />
                Add Service
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {addingService && (
            <ServiceForm
              baseCommissionRate={baseCommissionRate}
              onSubmit={handleAddService}
              onCancel={() => setAddingService(false)}
            />
          )}

          {services.map((service) => {
            if (editingServiceId === service.id) {
              return (
                <ServiceForm
                  key={service.id}
                  service={service}
                  baseCommissionRate={baseCommissionRate}
                  onSubmit={handleUpdateService}
                  onCancel={() => setEditingServiceId(null)}
                />
              );
            }

            return (
              <div key={service.id} className="p-4 border rounded-lg bg-gray-50">
                <div className="flex justify-between items-start mb-3">
                  <div className="flex-1">
                    <h4 className="font-medium text-lg">{service.service_name}</h4>
                    <p className="text-sm text-gray-600">
                      {service.service_type && <span className="font-medium">{service.service_type}</span>}
                      {service.service_type && ' • '}
                      {getBillingTypeLabel(service.billing_type)}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setEditingServiceId(service.id)}
                    >
                      <Edit2 className="h-4 w-4" />
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => handleDeleteService(service.id)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>

                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                  {service.billing_type === 'mrr' && service.monthly_price && (
                    <>
                      <div>
                        <span className="text-gray-600">Monthly Price:</span>
                        <p className="font-medium">{formatCurrency(service.monthly_price)}</p>
                      </div>
                      <div>
                        <span className="text-gray-600">Contract Months:</span>
                        <p className="font-medium">{service.contract_months}</p>
                      </div>
                    </>
                  )}
                  {service.billing_type === 'quarterly' && service.quarterly_price && (
                    <>
                      <div>
                        <span className="text-gray-600">Quarterly Price:</span>
                        <p className="font-medium">{formatCurrency(service.quarterly_price)}</p>
                      </div>
                      <div>
                        <span className="text-gray-600">Contract Quarters:</span>
                        <p className="font-medium">{service.contract_quarters}</p>
                      </div>
                    </>
                  )}
                  {(service.billing_type === 'one_off' || service.billing_type === 'deposit') && (
                    <div>
                      <span className="text-gray-600">Unit Price:</span>
                      <p className="font-medium">{formatCurrency(service.unit_price)}</p>
                    </div>
                  )}
                  <div>
                    <span className="text-gray-600">Quantity:</span>
                    <p className="font-medium">{service.quantity}</p>
                  </div>
                  <div>
                    <span className="text-gray-600">Commissionable Value:</span>
                    <p className="font-medium">{formatCurrency(service.commissionable_value)}</p>
                  </div>
                  <div>
                    <span className="text-gray-600">Commission Amount:</span>
                    <p className="font-medium">{formatCurrency(service.commission_amount)}</p>
                  </div>
                  {service.commission_rate && (
                    <div>
                      <span className="text-gray-600">Rate Override:</span>
                      <p className="font-medium">{(service.commission_rate * 100).toFixed(2)}%</p>
                    </div>
                  )}
                </div>
              </div>
            );
          })}

          {services.length === 0 && !addingService && (
            <p className="text-sm text-gray-500 text-center py-4">
              No services added yet. Click &quot;Add Service&quot; to get started.
            </p>
          )}

          {services.length > 0 && (
            <div className="pt-4 border-t">
              <div className="flex justify-between items-center">
                <span className="font-medium">Total Commission:</span>
                <span className="text-lg font-bold">
                  {formatCurrency(calculateDealTotalCommission(services))}
                </span>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Button type="submit" disabled={loading} className="w-full">
        {loading ? 'Saving...' : dealId ? 'Update Deal' : 'Create Deal'}
      </Button>
    </form>
  );
}
