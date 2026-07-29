'use client';

import { useCallback, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Upload, Check, HelpCircle, Loader2 } from 'lucide-react';
import type {
  ApplyChangePayload,
  ImportProposal,
  ImportProposalLine,
  ProposedChange,
} from '@/lib/commission/import-update/types';

interface ImportBossUpdateDialogProps {
  batchId: string;
  batchStatus: 'draft' | 'approved' | 'paid';
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onApplied: () => void;
  onRevertToDraft?: () => Promise<void>;
}

function changeToPayload(commission_entry_id: string, change: ProposedChange): ApplyChangePayload {
  const base = { commission_entry_id, action: change.action };
  switch (change.action) {
    case 'adjust_amount':
      return { ...base, override_amount: change.proposedValue as number | null };
    case 'update_payment_date':
      return { ...base, override_payment_date: change.proposedValue as string | null };
    case 'update_commission_rate':
      return { ...base, override_commission_rate: change.proposedValue as number | null };
    case 'update_amount_claimed':
      return { ...base, override_amount_collected: change.proposedValue as number | null };
    case 'add_note':
      return { ...base, adjustment_note: change.proposedValue as string | null };
    case 'override_to_renewal':
      return { ...base, previous_deal_amount: change.proposedValue as number };
    default:
      return base;
  }
}

export function ImportBossUpdateDialog({
  batchId,
  batchStatus,
  open,
  onOpenChange,
  onApplied,
  onRevertToDraft,
}: ImportBossUpdateDialogProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState('');
  const [proposal, setProposal] = useState<ImportProposal | null>(null);
  const [requiresDraft, setRequiresDraft] = useState(false);
  const [lines, setLines] = useState<ImportProposalLine[]>([]);
  const [clarificationAnswers, setClarificationAnswers] = useState<Record<number, string>>({});
  const [editedValues, setEditedValues] = useState<Record<string, string>>({});

  const reset = useCallback(() => {
    setProposal(null);
    setLines([]);
    setError('');
    setRequiresDraft(false);
    setClarificationAnswers({});
    setEditedValues({});
  }, []);

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setLoading(true);
    setError('');
    reset();
    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await fetch(`/api/commission/batches/${batchId}/import-update`, {
        method: 'POST',
        credentials: 'include',
        body: formData,
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        throw new Error(data.error || 'Failed to analyze file');
      }
      setProposal(data.proposal);
      setLines(data.proposal.lines ?? []);
      setRequiresDraft(!!data.requiresDraftToApply);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setLoading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const toggleLineAccepted = (rowIndex: number) => {
    setLines((prev) =>
      prev.map((l) => (l.rowIndex === rowIndex ? { ...l, accepted: !l.accepted } : l))
    );
  };

  const updateChangeValue = (rowIndex: number, changeIdx: number, value: string) => {
    const key = `${rowIndex}-${changeIdx}`;
    setEditedValues((prev) => ({ ...prev, [key]: value }));
    setLines((prev) =>
      prev.map((l) => {
        if (l.rowIndex !== rowIndex) return l;
        const changes = [...l.changes];
        const change = { ...changes[changeIdx] };
        if (change.action === 'update_commission_rate') {
          const pct = parseFloat(value);
          change.proposedValue = !isNaN(pct) ? pct / 100 : value;
        } else if (
          change.action === 'adjust_amount' ||
          change.action === 'update_amount_claimed' ||
          change.action === 'override_to_renewal'
        ) {
          const num = parseFloat(value);
          change.proposedValue = !isNaN(num) ? num : value;
        } else {
          change.proposedValue = value;
        }
        changes[changeIdx] = change;
        return { ...l, changes, accepted: true };
      })
    );
  };

  const handleClarify = async (line: ImportProposalLine) => {
    const answer = clarificationAnswers[line.rowIndex]?.trim();
    if (!answer) {
      alert('Please enter a clarification answer');
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(`/api/commission/batches/${batchId}/import-update`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ line, clarificationAnswer: answer }),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || 'Clarification failed');
      setLines((prev) => prev.map((l) => (l.rowIndex === line.rowIndex ? data.line : l)));
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : 'Clarification failed');
    } finally {
      setLoading(false);
    }
  };

  const handleApply = async () => {
    if (batchStatus !== 'draft') {
      if (onRevertToDraft && confirm('Revert to draft before applying boss updates?')) {
        setApplying(true);
        try {
          await onRevertToDraft();
        } finally {
          setApplying(false);
        }
      } else {
        alert('Batch must be in draft status to apply changes.');
        return;
      }
    }

    const acceptedLines = lines.filter((l) => l.accepted && l.commission_entry_id && l.changes.length > 0);
    if (acceptedLines.length === 0) {
      alert('No accepted changes to apply.');
      return;
    }

    const unresolved = acceptedLines.filter((l) => l.needsClarification);
    if (unresolved.length > 0) {
      alert(`${unresolved.length} accepted line(s) still need clarification. Resolve them first.`);
      return;
    }

    const changes: ApplyChangePayload[] = [];
    for (const line of acceptedLines) {
      for (const change of line.changes) {
        if (line.commission_entry_id) {
          changes.push(changeToPayload(line.commission_entry_id, change));
        }
      }
    }

    if (!confirm(`Apply ${changes.length} change(s) across ${acceptedLines.length} line(s)?`)) return;

    setApplying(true);
    try {
      const res = await fetch(`/api/commission/batches/${batchId}/apply-update`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ changes }),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        if (data.requiresDraft) {
          setRequiresDraft(true);
        }
        throw new Error(data.error || 'Apply failed');
      }
      alert(`Applied ${data.applied_count ?? 0} change(s)${data.failed_count ? `; ${data.failed_count} failed` : ''}.`);
      onApplied();
      onOpenChange(false);
      reset();
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : 'Apply failed');
    } finally {
      setApplying(false);
    }
  };

  const formatValue = (v: string | number | null | undefined): string => {
    if (v == null) return '—';
    if (typeof v === 'number') return String(v);
    return String(v);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) reset();
        onOpenChange(v);
      }}
    >
      <DialogContent className="max-w-5xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Import Boss Update</DialogTitle>
          <DialogDescription>
            Upload the annotated report your boss returned. The system will match rows, detect changes, and let you
            review before applying.
          </DialogDescription>
        </DialogHeader>

        {!proposal && (
          <div className="space-y-4">
            <input
              ref={fileInputRef}
              type="file"
              accept=".xlsx,.xls,.csv"
              className="hidden"
              onChange={handleFileSelect}
            />
            <Button variant="outline" onClick={() => fileInputRef.current?.click()} disabled={loading}>
              {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Upload className="mr-2 h-4 w-4" />}
              Choose Excel or CSV file
            </Button>
          </div>
        )}

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {requiresDraft && batchStatus !== 'draft' && (
          <Alert>
            <AlertDescription>
              This batch is {batchStatus}. Revert to draft to apply changes, or use import to preview differences only.
            </AlertDescription>
          </Alert>
        )}

        {proposal && (
          <div className="space-y-4">
            <div className="flex flex-wrap gap-2 text-sm">
              <Badge variant="outline">{proposal.summary.totalBossRows} boss rows</Badge>
              <Badge variant="secondary">{proposal.summary.matched} matched</Badge>
              {proposal.summary.ambiguous > 0 && (
                <Badge variant="destructive">{proposal.summary.ambiguous} ambiguous</Badge>
              )}
              {proposal.summary.unmatched > 0 && (
                <Badge variant="destructive">{proposal.summary.unmatched} unmatched</Badge>
              )}
              <Badge>{proposal.summary.withChanges} with changes</Badge>
              {proposal.summary.needsClarification > 0 && (
                <Badge variant="outline">{proposal.summary.needsClarification} need clarification</Badge>
              )}
              {!proposal.aiEnabled && (
                <Badge variant="outline">AI off — notes need manual review</Badge>
              )}
            </div>

            {proposal.unaddressedEntryIds.length > 0 && (
              <Alert>
                <AlertDescription>
                  {proposal.unaddressedEntryIds.length} batch entr
                  {proposal.unaddressedEntryIds.length === 1 ? 'y' : 'ies'} had no matching row in the boss file.
                </AlertDescription>
              </Alert>
            )}

            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">Apply</TableHead>
                  <TableHead>Client / Deal</TableHead>
                  <TableHead>Match</TableHead>
                  <TableHead>Proposed changes</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {lines.map((line) => (
                  <TableRow
                    key={line.rowIndex}
                    className={line.needsClarification ? 'bg-amber-50 dark:bg-amber-950/20' : undefined}
                  >
                    <TableCell>
                      <input
                        type="checkbox"
                        checked={line.accepted}
                        disabled={!line.commission_entry_id || line.changes.length === 0}
                        onChange={() => toggleLineAccepted(line.rowIndex)}
                        aria-label="Accept line changes"
                      />
                    </TableCell>
                    <TableCell>
                      <div className="font-medium">{line.bossRow.client_name}</div>
                      <div className="text-sm text-muted-foreground">
                        {line.bossRow.deal}
                        {line.bossRow.payment_sequence ? ` • ${line.bossRow.payment_sequence}` : ''}
                      </div>
                      {line.bossRow.freeformNotes && (
                        <div className="text-xs text-muted-foreground mt-1">Note: {line.bossRow.freeformNotes}</div>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          line.matchStatus === 'matched'
                            ? 'secondary'
                            : line.matchStatus === 'ambiguous'
                              ? 'destructive'
                              : 'outline'
                        }
                      >
                        {line.matchStatus}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {line.changes.length === 0 ? (
                        <span className="text-muted-foreground text-sm">No changes detected</span>
                      ) : (
                        <ul className="space-y-2 text-sm">
                          {line.changes.map((change, ci) => (
                            <li key={ci} className="flex flex-col gap-1">
                              <span>
                                [{change.source}] {change.description}
                              </span>
                              {change.action !== 'ignore_entry' && change.action !== 'remove_entry' && (
                                <Input
                                  className="h-8 max-w-xs"
                                  value={
                                    editedValues[`${line.rowIndex}-${ci}`] ??
                                    (change.action === 'update_commission_rate' && typeof change.proposedValue === 'number'
                                      ? String((change.proposedValue * 100).toFixed(2))
                                      : formatValue(change.proposedValue))
                                  }
                                  onChange={(e) => updateChangeValue(line.rowIndex, ci, e.target.value)}
                                />
                              )}
                            </li>
                          ))}
                        </ul>
                      )}
                      {line.needsClarification && (
                        <div className="mt-2 space-y-2">
                          <div className="flex items-start gap-1 text-amber-700 dark:text-amber-400 text-sm">
                            <HelpCircle className="h-4 w-4 shrink-0 mt-0.5" />
                            {line.clarificationQuestion}
                          </div>
                          <div className="flex gap-2">
                            <Input
                              placeholder="Your answer..."
                              value={clarificationAnswers[line.rowIndex] ?? ''}
                              onChange={(e) =>
                                setClarificationAnswers((prev) => ({ ...prev, [line.rowIndex]: e.target.value }))
                              }
                              className="h-8"
                            />
                            <Button size="sm" variant="outline" onClick={() => handleClarify(line)} disabled={loading}>
                              Re-interpret
                            </Button>
                          </div>
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          {proposal && (
            <Button onClick={handleApply} disabled={applying || loading}>
              {applying ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Check className="mr-2 h-4 w-4" />}
              Approve & Apply
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
