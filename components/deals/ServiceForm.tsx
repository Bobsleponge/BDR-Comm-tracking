'use client';

import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { calculateServiceCommission } from '@/lib/commission/calculator';

interface ServiceFormProps {
  service?: {
    id?: string;
    service_name: string;
    service_type?: string;
    billing_type: 'one_off' | 'mrr' | 'deposit' | 'quarterly';
    unit_price: number;
    monthly_price: number | null;
    quarterly_price: number | null;
    quantity: number;
    contract_months: number;
    contract_quarters: number;
    commission_rate: number | null;
    completion_date: string | null;
  };
  baseCommissionRate: number;
  onSubmit: (service: any) => void;
  onCancel: () => void;
}

export function ServiceForm({ service, baseCommissionRate, onSubmit, onCancel }: ServiceFormProps) {
  const [formData, setFormData] = useState({
    service_name: service?.service_name || '',
    service_type: service?.service_type || '',
    billing_type: service?.billing_type || 'one_off' as 'one_off' | 'mrr' | 'deposit' | 'quarterly',
    unit_price: service?.unit_price || 0,
    monthly_price: service?.monthly_price || null as number | null,
    quarterly_price: service?.quarterly_price || null as number | null,
    quantity: service?.quantity || 1,
    contract_months: service?.contract_months || 12,
    contract_quarters: service?.contract_quarters || 4,
    commission_rate: service?.commission_rate || null as number | null,
    completion_date: service?.completion_date || '',
  });

  const [calculation, setCalculation] = useState<{ commissionable_value: number; commission_amount: number } | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    // Recalculate when form data changes
    try {
      if (formData.service_name && formData.unit_price >= 0) {
        const calc = calculateServiceCommission(
          formData.billing_type,
          formData.unit_price,
          formData.monthly_price,
          formData.quarterly_price,
          formData.quantity,
          formData.contract_months,
          formData.contract_quarters,
          formData.commission_rate,
          baseCommissionRate
        );
        setCalculation(calc);
      } else {
        setCalculation(null);
      }
    } catch (err) {
      setCalculation(null);
    }
  }, [formData, baseCommissionRate]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const newErrors: Record<string, string> = {};

    if (!formData.service_name.trim()) {
      newErrors.service_name = 'Service name is required';
    }

    if (!formData.service_type.trim()) {
      newErrors.service_type = 'Service type is required';
    }

    if (formData.unit_price < 0) {
      newErrors.unit_price = 'Unit price must be positive';
    }

    if (formData.billing_type === 'mrr' && (!formData.monthly_price || formData.monthly_price <= 0)) {
      newErrors.monthly_price = 'Monthly price is required for MRR';
    }

    if (formData.billing_type === 'quarterly' && (!formData.quarterly_price || formData.quarterly_price <= 0)) {
      newErrors.quarterly_price = 'Quarterly price is required for quarterly billing';
    }

    if (formData.quantity < 1) {
      newErrors.quantity = 'Quantity must be at least 1';
    }

    if (formData.contract_months < 1) {
      newErrors.contract_months = 'Contract months must be at least 1';
    }

    if (formData.contract_quarters < 1) {
      newErrors.contract_quarters = 'Contract quarters must be at least 1';
    }

    if (Object.keys(newErrors).length > 0) {
      setErrors(newErrors);
      return;
    }

    setErrors({});
    onSubmit({
      ...formData,
      id: service?.id,
      monthly_price: formData.billing_type === 'mrr' ? formData.monthly_price : null,
      quarterly_price: formData.billing_type === 'quarterly' ? formData.quarterly_price : null,
      unit_price: formData.billing_type === 'mrr' || formData.billing_type === 'quarterly' ? 0 : formData.unit_price,
      completion_date: formData.completion_date || null,
      commission_rate: formData.commission_rate || null,
    });
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
    <form onSubmit={handleSubmit} className="space-y-4 p-4 border rounded-lg bg-gray-50">
      <div>
        <Label htmlFor="service_name">Service Name *</Label>
        <Input
          id="service_name"
          value={formData.service_name}
          onChange={(e) => setFormData({ ...formData, service_name: e.target.value })}
          required
        />
        {errors.service_name && <p className="text-sm text-red-600 mt-1">{errors.service_name}</p>}
      </div>

      <div>
        <Label htmlFor="service_type">Service Type *</Label>
        <Input
          id="service_type"
          value={formData.service_type}
          onChange={(e) => setFormData({ ...formData, service_type: e.target.value })}
          required
        />
        {errors.service_type && <p className="text-sm text-red-600 mt-1">{errors.service_type}</p>}
      </div>

      <div>
        <Label htmlFor="billing_type">Billing Type *</Label>
        <Select
          value={formData.billing_type}
          onValueChange={(value: 'one_off' | 'mrr' | 'deposit' | 'quarterly') => {
            setFormData({ ...formData, billing_type: value });
          }}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="one_off">One-Off Payment</SelectItem>
            <SelectItem value="mrr">Monthly Recurring Revenue (MRR)</SelectItem>
            <SelectItem value="quarterly">Recurring Quarterly</SelectItem>
            <SelectItem value="deposit">Deposit-Based Billing (50% / 50%)</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {(formData.billing_type === 'one_off' || formData.billing_type === 'deposit') && (
        <div>
          <Label htmlFor="unit_price">Unit Price *</Label>
          <Input
            id="unit_price"
            type="number"
            step="0.01"
            min="0"
            value={formData.unit_price}
            onChange={(e) => setFormData({ ...formData, unit_price: parseFloat(e.target.value) || 0 })}
            required
          />
          {errors.unit_price && <p className="text-sm text-red-600 mt-1">{errors.unit_price}</p>}
        </div>
      )}

      {formData.billing_type === 'mrr' && (
        <>
          <div>
            <Label htmlFor="monthly_price">Monthly Price *</Label>
            <Input
              id="monthly_price"
              type="number"
              step="0.01"
              min="0"
              value={formData.monthly_price || ''}
              onChange={(e) => setFormData({ ...formData, monthly_price: parseFloat(e.target.value) || null })}
              required
            />
            {errors.monthly_price && <p className="text-sm text-red-600 mt-1">{errors.monthly_price}</p>}
          </div>
          <div>
            <Label htmlFor="contract_months">Contract Months *</Label>
            <Input
              id="contract_months"
              type="number"
              min="1"
              value={formData.contract_months}
              onChange={(e) => setFormData({ ...formData, contract_months: parseInt(e.target.value) || 12 })}
              required
            />
            {errors.contract_months && <p className="text-sm text-red-600 mt-1">{errors.contract_months}</p>}
          </div>
        </>
      )}

      {formData.billing_type === 'quarterly' && (
        <>
          <div>
            <Label htmlFor="quarterly_price">Quarterly Price *</Label>
            <Input
              id="quarterly_price"
              type="number"
              step="0.01"
              min="0"
              value={formData.quarterly_price || ''}
              onChange={(e) => setFormData({ ...formData, quarterly_price: parseFloat(e.target.value) || null })}
              required
            />
            {errors.quarterly_price && <p className="text-sm text-red-600 mt-1">{errors.quarterly_price}</p>}
          </div>
          <div>
            <Label htmlFor="contract_quarters">Contract Quarters *</Label>
            <Input
              id="contract_quarters"
              type="number"
              min="1"
              value={formData.contract_quarters}
              onChange={(e) => setFormData({ ...formData, contract_quarters: parseInt(e.target.value) || 4 })}
              required
            />
            {errors.contract_quarters && <p className="text-sm text-red-600 mt-1">{errors.contract_quarters}</p>}
          </div>
        </>
      )}

      <div>
        <Label htmlFor="quantity">Quantity *</Label>
        <Input
          id="quantity"
          type="number"
          min="1"
          value={formData.quantity}
          onChange={(e) => setFormData({ ...formData, quantity: parseInt(e.target.value) || 1 })}
          required
        />
        {errors.quantity && <p className="text-sm text-red-600 mt-1">{errors.quantity}</p>}
      </div>

      {formData.billing_type === 'deposit' && (
        <div>
          <Label htmlFor="completion_date">Completion Date</Label>
          <Input
            id="completion_date"
            type="date"
            value={formData.completion_date}
            onChange={(e) => setFormData({ ...formData, completion_date: e.target.value })}
          />
          <p className="text-xs text-muted-foreground mt-1">
            Date when the remaining 50% will be paid
          </p>
        </div>
      )}

      <div>
        <Label htmlFor="commission_rate">Commission Rate Override (optional)</Label>
        <Input
          id="commission_rate"
          type="number"
          step="0.0001"
          min="0"
          max="1"
          value={formData.commission_rate || ''}
          onChange={(e) => setFormData({ ...formData, commission_rate: parseFloat(e.target.value) || null })}
          placeholder={`Default: ${(baseCommissionRate * 100).toFixed(2)}%`}
        />
        <p className="text-xs text-muted-foreground mt-1">
          Leave empty to use default rate ({baseCommissionRate * 100}%)
        </p>
      </div>

      {calculation && (
        <div className="p-3 bg-blue-50 border border-blue-200 rounded">
          <h4 className="font-medium text-sm mb-2">Commission Calculation</h4>
          <div className="space-y-1 text-sm">
            <div className="flex justify-between">
              <span className="text-gray-600">Commissionable Value:</span>
              <span className="font-medium">{formatCurrency(calculation.commissionable_value)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-600">Commission Amount:</span>
              <span className="font-medium">{formatCurrency(calculation.commission_amount)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-600">Rate Used:</span>
              <span className="font-medium">
                {((formData.commission_rate ?? baseCommissionRate) * 100).toFixed(2)}%
              </span>
            </div>
          </div>
        </div>
      )}

      <div className="flex gap-2">
        <Button type="submit">{service ? 'Update Service' : 'Add Service'}</Button>
        <Button type="button" variant="outline" onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}

