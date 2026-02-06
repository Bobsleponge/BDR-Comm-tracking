'use client';

import { useState, useEffect } from 'react';

interface CommissionRules {
  base_rate: number;
  quarterly_bonus_rate: number;
  renewal_rate: number;
  payout_months_default: number;
  tier_1_threshold: number | null;
  tier_1_rate: number | null;
  tier_2_rate: number | null;
  quarterly_target: number | null;
  clawback_days: number | null;
}

export function RulesEditor() {
  const [rules, setRules] = useState<CommissionRules | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    fetchRules();
  }, []);

  const fetchRules = async () => {
    try {
      const res = await fetch('/api/rules');
      if (!res.ok) throw new Error('Failed to fetch rules');
      const data = await res.json();
      setRules(data);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    setSuccess(false);

    try {
      const res = await fetch('/api/rules', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(rules),
      });

      if (!res.ok) {
        const errorData = await res.json();
        throw new Error(errorData.error || 'Failed to update rules');
      }

      setSuccess(true);
      setTimeout(() => setSuccess(false), 3000);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div>Loading rules...</div>;
  }

  if (!rules) {
    return <div>No rules found</div>;
  }

  return (
    <div className="bg-white shadow rounded-lg p-6">
      <h3 className="text-lg font-medium text-gray-900 mb-4">Commission Rules</h3>

      {error && (
        <div className="mb-4 bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded">
          {error}
        </div>
      )}

      {success && (
        <div className="mb-4 bg-green-50 border border-green-200 text-green-700 px-4 py-3 rounded">
          Rules updated successfully!
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-6">
        {/* Tiered Commission Structure */}
        <div className="border-t border-gray-200 pt-6">
          <h4 className="text-base font-medium text-gray-900 mb-4">Tiered Commission Structure</h4>
          <p className="text-sm text-gray-500 mb-4">
            Commissions are paid on cash collected in the first 12 months. Tiered rates apply based on cumulative annual collected revenue.
          </p>
          
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div>
              <label className="block text-sm font-medium text-gray-700">
                Tier 1 Threshold (USD)
              </label>
              <input
                type="number"
                step="0.01"
                min="0"
                value={rules.tier_1_threshold ?? ''}
                onChange={(e) => setRules({
                  ...rules,
                  tier_1_threshold: e.target.value ? parseFloat(e.target.value) : null,
                })}
                className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
                placeholder="250000"
              />
              <p className="mt-1 text-xs text-gray-500">First threshold amount</p>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700">
                Tier 1 Rate (%)
              </label>
              <input
                type="number"
                step="0.0001"
                min="0"
                max="100"
                value={rules.tier_1_rate ? (rules.tier_1_rate * 100).toFixed(4) : ''}
                onChange={(e) => setRules({
                  ...rules,
                  tier_1_rate: e.target.value ? parseFloat(e.target.value) / 100 : null,
                })}
                className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
                placeholder="2.5"
              />
              <p className="mt-1 text-xs text-gray-500">Rate for first tier</p>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700">
                Tier 2 Rate (%)
              </label>
              <input
                type="number"
                step="0.0001"
                min="0"
                max="100"
                value={rules.tier_2_rate ? (rules.tier_2_rate * 100).toFixed(4) : ''}
                onChange={(e) => setRules({
                  ...rules,
                  tier_2_rate: e.target.value ? parseFloat(e.target.value) / 100 : null,
                })}
                className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
                placeholder="5.0"
              />
              <p className="mt-1 text-xs text-gray-500">Rate above threshold (uncapped)</p>
            </div>
          </div>
        </div>

        {/* Quarterly Bonus */}
        <div className="border-t border-gray-200 pt-6">
          <h4 className="text-base font-medium text-gray-900 mb-4">Quarterly Performance Bonus</h4>
          
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="block text-sm font-medium text-gray-700">
                Quarterly Target (USD)
              </label>
              <input
                type="number"
                step="0.01"
                min="0"
                value={rules.quarterly_target ?? ''}
                onChange={(e) => setRules({
                  ...rules,
                  quarterly_target: e.target.value ? parseFloat(e.target.value) : null,
                })}
                className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
                placeholder="75000"
              />
              <p className="mt-1 text-xs text-gray-500">Target revenue for quarter</p>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700">
                Quarterly Bonus Rate (%)
              </label>
              <input
                type="number"
                step="0.0001"
                min="0"
                max="100"
                value={(rules.quarterly_bonus_rate * 100).toFixed(4)}
                onChange={(e) => setRules({
                  ...rules,
                  quarterly_bonus_rate: parseFloat(e.target.value) / 100,
                })}
                className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
              />
              <p className="mt-1 text-xs text-gray-500">Bonus rate when 100% target reached</p>
            </div>
          </div>
        </div>

        {/* Legacy/Default Rates */}
        <div className="border-t border-gray-200 pt-6">
          <h4 className="text-base font-medium text-gray-900 mb-4">Default Rates (Legacy Support)</h4>
          <p className="text-sm text-gray-500 mb-4">
            These rates are used as fallbacks when tiered structure is not configured or for legacy deals.
          </p>
          
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="block text-sm font-medium text-gray-700">
                Base Commission Rate (%)
              </label>
              <input
                type="number"
                step="0.0001"
                min="0"
                max="100"
                value={(rules.base_rate * 100).toFixed(4)}
                onChange={(e) => setRules({
                  ...rules,
                  base_rate: parseFloat(e.target.value) / 100,
                })}
                className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
              />
              <p className="mt-1 text-xs text-gray-500">Default: 2.5%</p>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700">
                Renewal Rate (%)
              </label>
              <input
                type="number"
                step="0.0001"
                min="0"
                max="100"
                value={(rules.renewal_rate * 100).toFixed(4)}
                onChange={(e) => setRules({
                  ...rules,
                  renewal_rate: parseFloat(e.target.value) / 100,
                })}
                className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
              />
              <p className="mt-1 text-xs text-gray-500">Default: 1%</p>
            </div>
          </div>
        </div>

        {/* Other Settings */}
        <div className="border-t border-gray-200 pt-6">
          <h4 className="text-base font-medium text-gray-900 mb-4">Other Settings</h4>
          
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="block text-sm font-medium text-gray-700">
                Default Payout Months
              </label>
              <input
                type="number"
                min="1"
                max="60"
                value={rules.payout_months_default}
                onChange={(e) => setRules({
                  ...rules,
                  payout_months_default: parseInt(e.target.value, 10),
                })}
                className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
              />
              <p className="mt-1 text-xs text-gray-500">Default: 12 months</p>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700">
                Clawback Period (Days)
              </label>
              <input
                type="number"
                min="0"
                max="365"
                value={rules.clawback_days ?? ''}
                onChange={(e) => setRules({
                  ...rules,
                  clawback_days: e.target.value ? parseInt(e.target.value, 10) : null,
                })}
                className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
                placeholder="90"
              />
              <p className="mt-1 text-xs text-gray-500">Days for commission reversal on refunds</p>
            </div>
          </div>
        </div>

        <div className="border-t border-gray-200 pt-6">
          <button
            type="submit"
            disabled={saving}
            className="px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50"
          >
            {saving ? 'Saving...' : 'Save Rules'}
          </button>
        </div>
      </form>
    </div>
  );
}
