/**
 * Convert data to CSV format
 */
export function convertToCSV(data: any[], headers: string[]): string {
  const csvRows: string[] = [];

  // Add headers
  csvRows.push(headers.join(','));

  // Add data rows
  for (const row of data) {
    const values = headers.map(header => {
      const value = row[header] ?? '';
      // Escape commas and quotes in values
      if (typeof value === 'string' && (value.includes(',') || value.includes('"'))) {
        return `"${value.replace(/"/g, '""')}"`;
      }
      return value;
    });
    csvRows.push(values.join(','));
  }

  return csvRows.join('\n');
}

/**
 * Download CSV file
 */
export function downloadCSV(csvContent: string, filename: string) {
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement('a');
  const url = URL.createObjectURL(blob);
  
  link.setAttribute('href', url);
  link.setAttribute('download', filename);
  link.style.visibility = 'hidden';
  
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

/**
 * Export deals to CSV
 */
export function exportDealsToCSV(deals: any[]) {
  const headers = [
    'Client Name',
    'Service Type',
    'Deal Value',
    'Status',
    'Proposal Date',
    'Close Date',
    'First Invoice Date',
    'Payout Months',
  ];

  const csvData = deals.map(deal => ({
    'Client Name': deal.client_name,
    'Service Type': deal.service_type,
    'Deal Value': deal.deal_value,
    'Status': deal.status,
    'Proposal Date': deal.proposal_date,
    'Close Date': deal.close_date || '',
    'First Invoice Date': deal.first_invoice_date || '',
    'Payout Months': deal.payout_months,
  }));

  const csv = convertToCSV(csvData, headers);
  downloadCSV(csv, `deals-export-${new Date().toISOString().split('T')[0]}.csv`);
}

/**
 * Export commission entries to CSV
 */
export function exportCommissionToCSV(entries: any[]) {
  const headers = [
    'Month',
    'Client Name',
    'Service Type',
    'Amount',
    'Status',
  ];

  const csvData = entries.map(entry => ({
    'Month': entry.month,
    'Client Name': entry.deals?.client_name || '',
    'Service Type': entry.deals?.service_type || '',
    'Amount': entry.amount,
    'Status': entry.status,
  }));

  const csv = convertToCSV(csvData, headers);
  downloadCSV(csv, `commission-export-${new Date().toISOString().split('T')[0]}.csv`);
}







