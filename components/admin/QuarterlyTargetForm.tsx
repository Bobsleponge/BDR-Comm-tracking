'use client';

import { useState, useEffect } from 'react';

interface BDRRep {
  id: string;
  name: string;
  email: string;
}

export function QuarterlyTargetForm() {
  const [reps, setReps] = useState<BDRRep[]>([]);
  const [formData, setFormData] = useState({
    bdr_id: '',
    quarter: '',
    target_revenue: '',
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    fetchReps();
    // Set default quarter to current quarter
    const now = new Date();
    const year = now.getFullYear();
    const quarter = Math.ceil((now.getMonth() + 1) / 3);
    setFormData(prev => ({ ...prev, quarter: `${year}-Q${quarter}` }));
  }, []);

  const fetchReps = async () => {
    try {
      const res = await fetch('/api/bdr-reps');
      if (res.ok) {
        const data = await res.json();
        setReps(data);
      }
    } catch (err) {
      console.error('Failed to fetch reps:', err);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    setSuccess(false);

    try {
      const res = await fetch('/api/quarterly-targets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...formData,
          target_revenue: parseFloat(formData.target_revenue),
        }),
      });

      if (!res.ok) {
        const errorData = await res.json();
        throw new Error(errorData.error || 'Failed to set target');
      }

      setSuccess(true);
      setFormData({
        bdr_id: '',
        quarter: formData.quarter, // Keep quarter
        target_revenue: '',
      });
      setTimeout(() => setSuccess(false), 3000);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="bg-white shadow rounded-lg p-6">
      <h3 className="text-lg font-medium text-gray-900 mb-4">Set Quarterly Target</h3>

      {error && (
        <div className="mb-4 bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded">
          {error}
        </div>
      )}

      {success && (
        <div className="mb-4 bg-green-50 border border-green-200 text-green-700 px-4 py-3 rounded">
          Target set successfully!
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700">
            BDR Rep
          </label>
          <select
            required
            value={formData.bdr_id}
            onChange={(e) => setFormData({ ...formData, bdr_id: e.target.value })}
            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
          >
            <option value="">Select BDR</option>
            {reps.map((rep) => (
              <option key={rep.id} value={rep.id}>
                {rep.name} ({rep.email})
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700">
            Quarter
          </label>
          <input
            type="text"
            required
            pattern="\d{4}-Q[1-4]"
            placeholder="2024-Q1"
            value={formData.quarter}
            onChange={(e) => setFormData({ ...formData, quarter: e.target.value })}
            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
          />
          <p className="mt-1 text-sm text-gray-500">Format: YYYY-QN (e.g., 2024-Q1)</p>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700">
            Target Revenue ($)
          </label>
          <input
            type="number"
            required
            step="0.01"
            min="0"
            value={formData.target_revenue}
            onChange={(e) => setFormData({ ...formData, target_revenue: e.target.value })}
            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
          />
        </div>

        <div>
          <button
            type="submit"
            disabled={loading}
            className="px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50"
          >
            {loading ? 'Setting...' : 'Set Target'}
          </button>
        </div>
      </form>
    </div>
  );
}





