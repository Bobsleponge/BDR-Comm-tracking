'use client';

import { useState, useEffect } from 'react';
import { AuthGuard } from '@/components/shared/AuthGuard';
import { Layout } from '@/components/shared/Layout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Calculator, Plus, Trash2, ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import type { PreviewDeal, PreviewService, CommissionPreviewResult } from '@/lib/commission/preview';
import { format } from 'date-fns';

const BILLING_TYPES = [
  { value: 'one_off', label: 'One-Off Payment' },
  { value: 'mrr', label: 'Monthly Recurring (MRR)' },
  { value: 'quarterly', label: 'Recurring Quarterly' },
  { value: 'deposit', label: 'Deposit (50% / 50%)' },
  { value: 'paid_on_completion', label: 'Paid on Completion' },
  { value: 'percentage_of_net_sales', label: 'Percentage of Net Sales' },
] as const;

const emptyService: PreviewService = {
  service_name: '',
  service_type: 'Consulting',
  billing_type: 'one_off',
  unit_price: 0,
  monthly_price: null,
  quarterly_price: null,
  quantity: 1,
  contract_months: 12,
  contract_quarters: 4,
  commission_rate: null,
  completion_date: null,
};

function formatCurrency(value: number) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function formatMonth(monthStr: string) {
  const [y, m] = monthStr.split('-');
  return new Date(parseInt(y), parseInt(m) - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

export default function CommissionPreviewPage() {
  const today = new Date().toISOString().split('T')[0];
  const [deal, setDeal] = useState<PreviewDeal>({
    client_name: '',
    close_date: today,
    first_invoice_date: '',
    is_renewal: false,
    original_deal_value: null,
  });
  const [services, setServices] = useState<PreviewService[]>([{ ...emptyService }]);
  const [baseRate, setBaseRate] = useState(0.025);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<CommissionPreviewResult | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    fetch('/api/rules')
      .then((r) => r.ok ? r.json() : null)
      .then((data) => {
        if (data?.base_rate != null) setBaseRate(data.base_rate);
      })
      .catch(() => {});
  }, []);

  const addService = () => {
    setServices((s) => [...s, { ...emptyService }]);
  };

  const removeService = (i: number) => {
    if (services.length <= 1) return;
    setServices((s) => s.filter((_, j) => j !== i));
  };

  const updateService = (i: number, updates: Partial<PreviewService>) => {
    setServices((s) => s.map((svc, j) => (j === i ? { ...svc, ...updates } : svc)));
  };

  const handleCalculate = async () => {
    setError('');
    setResult(null);

    const firstInvoice = deal.first_invoice_date || undefined;
    const closeDate = deal.close_date;
    if (!closeDate) {
      setError('Close date is required');
      return;
    }

    const validServices = services
      .map((s) => ({
        ...s,
        service_name: s.service_name.trim(),
        service_type: s.service_type || 'Consulting',
        unit_price: (s.billing_type === 'mrr' || s.billing_type === 'quarterly' || s.billing_type === 'percentage_of_net_sales') ? 0 : (s.unit_price ?? 0),
        monthly_price: s.billing_type === 'mrr' ? (s.monthly_price ?? null) : null,
        quarterly_price: s.billing_type === 'quarterly' ? (s.quarterly_price ?? null) : null,
        quantity: s.quantity ?? 1,
        contract_months: s.contract_months ?? 12,
        contract_quarters: s.contract_quarters ?? 4,
        commission_rate: s.commission_rate ?? null,
        completion_date: s.completion_date || null,
      }))
      .filter((s) => s.service_name && ((s.billing_type === 'mrr' && s.monthly_price) || (s.billing_type === 'quarterly' && s.quarterly_price) || (s.billing_type === 'percentage_of_net_sales' && s.billing_percentage) || (s.unit_price > 0)));

    if (validServices.length === 0) {
      setError('Add at least one service with valid pricing');
      return;
    }

    setLoading(true);
    try {
      const res = await fetch('/api/commission/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          deal: { ...deal, first_invoice_date: firstInvoice || null },
          services: validServices,
        }),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        throw new Error(data.error || 'Preview failed');
      }
      setResult(data);
    } catch (err: any) {
      setError(err.message || 'Failed to calculate preview');
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthGuard>
      <Layout>
        <div className="px-4 py-6 sm:px-0 max-w-4xl mx-auto">
          <div className="mb-6 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Link href="/dashboard">
                <Button variant="ghost" size="icon">
                  <ArrowLeft className="h-4 w-4" />
                </Button>
              </Link>
              <div>
                <h1 className="text-2xl font-bold">Commission Preview</h1>
                <p className="text-sm text-muted-foreground">
                  See what you&apos;d earn if this deal closed — no data is saved
                </p>
              </div>
            </div>
          </div>

          <Card className="mb-6">
            <CardHeader>
              <CardTitle>Deal Details</CardTitle>
              <p className="text-sm text-muted-foreground">Enter hypothetical deal info</p>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <Label>Client Name</Label>
                <Input
                  value={deal.client_name}
                  onChange={(e) => setDeal((d) => ({ ...d, client_name: e.target.value }))}
                  placeholder="Acme Corp"
                />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <Label>Close Date *</Label>
                  <Input
                    type="date"
                    value={deal.close_date}
                    onChange={(e) => setDeal((d) => ({ ...d, close_date: e.target.value }))}
                  />
                </div>
                <div>
                  <Label>First Invoice Date</Label>
                  <Input
                    type="date"
                    value={deal.first_invoice_date || ''}
                    onChange={(e) => setDeal((d) => ({ ...d, first_invoice_date: e.target.value || null }))}
                    placeholder="Defaults to close + 7 days"
                  />
                </div>
              </div>
              <div className="flex items-center gap-4">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={!!deal.is_renewal}
                    onChange={(e) => setDeal((d) => ({ ...d, is_renewal: e.target.checked }))}
                  />
                  <span>Renewal deal</span>
                </label>
                {deal.is_renewal && (
                  <div className="flex-1 max-w-[200px]">
                    <Label>Original Deal Value ($)</Label>
                    <Input
                      type="number"
                      min="0"
                      step="0.01"
                      value={deal.original_deal_value ?? ''}
                      onChange={(e) =>
                        setDeal((d) => ({
                          ...d,
                          original_deal_value: e.target.value ? parseFloat(e.target.value) : null,
                        }))
                      }
                      placeholder="Previous amount"
                    />
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

          <Card className="mb-6">
            <CardHeader className="flex flex-row items-center justify-between">
              <div>
                <CardTitle>Services</CardTitle>
                <p className="text-sm text-muted-foreground">Add one or more services</p>
              </div>
              <Button type="button" variant="outline" size="sm" onClick={addService}>
                <Plus className="h-4 w-4 mr-1" />
                Add Service
              </Button>
            </CardHeader>
            <CardContent className="space-y-6">
              {services.map((svc, i) => (
                <div key={i} className="p-4 border rounded-lg bg-muted/30 space-y-4">
                  <div className="flex justify-between items-center">
                    <span className="font-medium">Service {i + 1}</span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => removeService(i)}
                      disabled={services.length <= 1}
                    >
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                      <Label>Name *</Label>
                      <Input
                        value={svc.service_name}
                        onChange={(e) => updateService(i, { service_name: e.target.value })}
                        placeholder="e.g. Consulting"
                      />
                    </div>
                    <div>
                      <Label>Billing Type</Label>
                      <Select
                        value={svc.billing_type}
                        onValueChange={(v: any) => updateService(i, { billing_type: v })}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {BILLING_TYPES.map((b) => (
                            <SelectItem key={b.value} value={b.value}>
                              {b.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  {(svc.billing_type === 'one_off' || svc.billing_type === 'deposit' || svc.billing_type === 'paid_on_completion') && (
                    <div>
                      <Label>Unit Price ($) *</Label>
                      <Input
                        type="number"
                        min="0"
                        step="0.01"
                        value={svc.unit_price || ''}
                        onChange={(e) => updateService(i, { unit_price: parseFloat(e.target.value) || 0 })}
                      />
                    </div>
                  )}
                  {svc.billing_type === 'mrr' && (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div>
                        <Label>Monthly Price ($) *</Label>
                        <Input
                          type="number"
                          min="0"
                          step="0.01"
                          value={svc.monthly_price ?? ''}
                          onChange={(e) => updateService(i, { monthly_price: parseFloat(e.target.value) || null })}
                        />
                      </div>
                      <div>
                        <Label>Contract Months</Label>
                        <Input
                          type="number"
                          min="1"
                          value={svc.contract_months}
                          onChange={(e) => updateService(i, { contract_months: parseInt(e.target.value) || 12 })}
                        />
                      </div>
                    </div>
                  )}
                  {svc.billing_type === 'percentage_of_net_sales' && (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div>
                        <Label>Billing Percentage (%) *</Label>
                        <Input
                          type="number"
                          min="0.01"
                          max="100"
                          step="0.01"
                          value={svc.billing_percentage != null ? svc.billing_percentage * 100 : ''}
                          onChange={(e) => {
                            const v = parseFloat(e.target.value);
                            updateService(i, { billing_percentage: isNaN(v) ? null : v / 100 });
                          }}
                          placeholder="e.g. 5 for 5%"
                        />
                      </div>
                      <div>
                        <Label>Contract Months</Label>
                        <Input
                          type="number"
                          min="1"
                          value={svc.contract_months}
                          onChange={(e) => updateService(i, { contract_months: parseInt(e.target.value) || 12 })}
                        />
                      </div>
                    </div>
                  )}
                  {svc.billing_type === 'quarterly' && (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div>
                        <Label>Quarterly Price ($) *</Label>
                        <Input
                          type="number"
                          min="0"
                          step="0.01"
                          value={svc.quarterly_price ?? ''}
                          onChange={(e) => updateService(i, { quarterly_price: parseFloat(e.target.value) || null })}
                        />
                      </div>
                      <div>
                        <Label>Contract Quarters</Label>
                        <Input
                          type="number"
                          min="1"
                          value={svc.contract_quarters}
                          onChange={(e) => updateService(i, { contract_quarters: parseInt(e.target.value) || 4 })}
                        />
                      </div>
                    </div>
                  )}
                  {(svc.billing_type === 'deposit' || svc.billing_type === 'paid_on_completion') && (
                    <div>
                      <Label>{svc.billing_type === 'paid_on_completion' ? 'Estimated Completion Date' : 'Completion Date (for 2nd 50%)'}</Label>
                      <Input
                        type="date"
                        value={svc.completion_date || ''}
                        onChange={(e) => updateService(i, { completion_date: e.target.value || null })}
                      />
                    </div>
                  )}
                  <div>
                    <Label>Quantity</Label>
                    <Input
                      type="number"
                      min="1"
                      value={svc.quantity}
                      onChange={(e) => updateService(i, { quantity: parseInt(e.target.value) || 1 })}
                    />
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>

          {error && (
            <div className="mb-6 p-4 bg-destructive/10 border border-destructive/20 rounded-lg text-destructive text-sm">
              {error}
            </div>
          )}

          <div className="mb-6">
            <Button
              size="lg"
              className="w-full sm:w-auto"
              onClick={handleCalculate}
              disabled={loading}
            >
              <Calculator className="h-4 w-4 mr-2" />
              {loading ? 'Calculating…' : 'Calculate Preview'}
            </Button>
          </div>

          {result && (
            <Card>
              <CardHeader>
                <CardTitle>Preview Results</CardTitle>
                <p className="text-sm text-muted-foreground">
                  {result.summary.entryCount} commission entries across {result.summary.monthCount} months
                </p>
              </CardHeader>
              <CardContent className="space-y-6">
                <div className="flex flex-wrap gap-4">
                  <div className="rounded-lg bg-primary/10 px-4 py-3">
                    <p className="text-sm text-muted-foreground">Total Commission</p>
                    <p className="text-2xl font-bold">{formatCurrency(result.totalCommission)}</p>
                  </div>
                  <div className="rounded-lg bg-muted px-4 py-3">
                    <p className="text-sm text-muted-foreground">Total Revenue (collected)</p>
                    <p className="text-xl font-semibold">{formatCurrency(result.summary.totalRevenueCollected)}</p>
                  </div>
                </div>

                <div>
                  <h3 className="font-semibold mb-3">By Month</h3>
                  <div className="space-y-4">
                    {result.byMonth.map((m) => (
                      <div key={m.month} className="border rounded-lg p-4">
                        <div className="flex justify-between items-center mb-2">
                          <span className="font-medium">{formatMonth(m.month)}</span>
                          <span className="font-semibold">{formatCurrency(m.amount)}</span>
                        </div>
                        <ul className="text-sm text-muted-foreground space-y-1">
                          {m.entries.map((e, j) => (
                            <li key={j} className="flex justify-between">
                              <span>
                                {e.service_name} — {e.billing_type} — {formatCurrency(e.amount_collected)} collected
                              </span>
                              <span>{formatCurrency(e.amount)} @ {(e.commission_rate * 100).toFixed(2)}%</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ))}
                  </div>
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      </Layout>
    </AuthGuard>
  );
}
