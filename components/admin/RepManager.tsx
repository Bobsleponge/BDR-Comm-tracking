'use client';

import { useState, useEffect } from 'react';

interface BDRRep {
  id: string;
  name: string;
  email: string;
  status: 'active' | 'inactive';
}

export function RepManager() {
  const [reps, setReps] = useState<BDRRep[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [formData, setFormData] = useState({
    name: '',
    email: '',
    status: 'active' as 'active' | 'inactive',
  });

  useEffect(() => {
    fetchReps();
  }, []);

  const fetchReps = async () => {
    try {
      const res = await fetch('/api/bdr-reps');
      if (!res.ok) throw new Error('Failed to fetch reps');
      const data = await res.json();
      setReps(data);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    try {
      const url = editing ? `/api/bdr-reps/${editing}` : '/api/bdr-reps';
      const method = editing ? 'PATCH' : 'POST';

      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData),
      });

      if (!res.ok) {
        const errorData = await res.json();
        throw new Error(errorData.error || 'Failed to save rep');
      }

      setEditing(null);
      setFormData({ name: '', email: '', status: 'active' });
      fetchReps();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleEdit = (rep: BDRRep) => {
    setEditing(rep.id);
    setFormData({
      name: rep.name,
      email: rep.email,
      status: rep.status,
    });
  };

  const handleCancel = () => {
    setEditing(null);
    setFormData({ name: '', email: '', status: 'active' });
  };

  const handleStatusToggle = async (repId: string, currentStatus: string) => {
    try {
      const res = await fetch(`/api/bdr-reps/${repId}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: currentStatus === 'active' ? 'inactive' : 'active',
        }),
      });

      if (!res.ok) throw new Error('Failed to update status');
      fetchReps();
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleDelete = async (repId: string, repName: string) => {
    if (!confirm(`Are you sure you want to delete ${repName}? This action cannot be undone.`)) {
      return;
    }

    try {
      const res = await fetch(`/api/bdr-reps/${repId}`, {
        method: 'DELETE',
      });

      if (!res.ok) {
        const errorData = await res.json();
        throw new Error(errorData.error || 'Failed to delete rep');
      }

      fetchReps();
    } catch (err: any) {
      alert(err.message);
    }
  };

  if (loading) {
    return <div>Loading...</div>;
  }

  return (
    <div className="bg-white shadow rounded-lg p-6">
      <h3 className="text-lg font-medium text-gray-900 mb-4">BDR Reps</h3>

      {error && (
        <div className="mb-4 bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded">
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} className="mb-6 space-y-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <input
            type="text"
            placeholder="Name"
            required
            value={formData.name}
            onChange={(e) => setFormData({ ...formData, name: e.target.value })}
            className="rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
          />
          <input
            type="email"
            placeholder="Email"
            required
            value={formData.email}
            onChange={(e) => setFormData({ ...formData, email: e.target.value })}
            className="rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
          />
          <div className="flex space-x-2">
            <button
              type="submit"
              className="px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700"
            >
              {editing ? 'Update' : 'Add'} Rep
            </button>
            {editing && (
              <button
                type="button"
                onClick={handleCancel}
                className="px-4 py-2 border border-gray-300 rounded-md shadow-sm text-sm font-medium text-gray-700 bg-white hover:bg-gray-50"
              >
                Cancel
              </button>
            )}
          </div>
        </div>
      </form>

      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Name</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Email</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Actions</th>
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-200">
            {reps.map((rep) => (
              <tr key={rep.id}>
                <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">
                  {rep.name}
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                  {rep.email}
                </td>
                <td className="px-6 py-4 whitespace-nowrap">
                  <span className={`px-2 inline-flex text-xs leading-5 font-semibold rounded-full ${
                    rep.status === 'active' ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'
                  }`}>
                    {rep.status}
                  </span>
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-sm font-medium space-x-2">
                  <button
                    onClick={() => handleEdit(rep)}
                    className="text-indigo-600 hover:text-indigo-900"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => handleStatusToggle(rep.id, rep.status)}
                    className="text-gray-600 hover:text-gray-900"
                  >
                    {rep.status === 'active' ? 'Deactivate' : 'Activate'}
                  </button>
                  <button
                    onClick={() => handleDelete(rep.id, rep.name)}
                    className="text-red-600 hover:text-red-900"
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}




