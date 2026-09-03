import React, { useMemo, useState } from 'react';
import CloseIcon from '@mui/icons-material/Close';
import { RoutePolyline } from '../types/route';

interface CoupleRouteModalProps {
  /** relation_id of the route the MergeIcon was clicked on (the one that keeps its identity). */
  relation_id: number;
  /** All routes currently shown in the right panel (one entry per path). */
  routePolylines: RoutePolyline[];
  onClose: () => void;
  onCoupled: () => void;
}

interface Candidate {
  relation_id: number;
  name: string;
}

const CoupleRouteModal: React.FC<CoupleRouteModalProps> = ({
  relation_id,
  routePolylines,
  onClose,
  onCoupled,
}) => {
  const [selectedRelationId, setSelectedRelationId] = useState<number | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  // Routes shown in the panel, deduplicated by relation_id, keeping only those
  // with exactly one path and excluding the clicked route itself.
  const candidates: Candidate[] = useMemo(() => {
    const pathCount = new Map<number, number>();
    for (const rp of routePolylines) {
      if (rp.relation_id === undefined) continue;
      pathCount.set(rp.relation_id, (pathCount.get(rp.relation_id) ?? 0) + 1);
    }
    const seen = new Set<number>();
    const list: Candidate[] = [];
    for (const rp of routePolylines) {
      if (rp.relation_id === undefined) continue;
      if (rp.relation_id === relation_id) continue;
      if (seen.has(rp.relation_id)) continue;
      if ((pathCount.get(rp.relation_id) ?? 0) !== 1) continue;
      seen.add(rp.relation_id);
      list.push({ relation_id: rp.relation_id, name: rp.name });
    }
    return list;
  }, [routePolylines, relation_id]);

  const handleOk = async () => {
    if (selectedRelationId === null) return;
    setIsSaving(true);
    try {
      const res = await fetch(`/api/routes/${relation_id}/couple`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target_relation_id: selectedRelationId }),
      });
      if (res.ok) {
        onCoupled();
      } else {
        console.error('[CoupleRouteModal] server error:', await res.text());
      }
    } finally {
      setIsSaving(false);
    }
  };

  const handleBackdropClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) onClose();
  };

  return (
    <div className="names-modal-overlay" onClick={handleBackdropClick}>
      <div className="names-modal">
        <button className="names-modal-close" onClick={onClose} title="閉じる">
          <CloseIcon fontSize="small" />
        </button>

        <p className="names-modal-message">カップリングする路線を選択してください</p>

        <div className="names-modal-list couple-modal-list">
          {candidates.length === 0 ? (
            <p className="names-modal-loading">カップリング可能な路線がありません</p>
          ) : (
            candidates.map((c) => (
              <label key={c.relation_id} className="couple-modal-row">
                <input
                  type="radio"
                  name="couple-target"
                  checked={selectedRelationId === c.relation_id}
                  onChange={() => setSelectedRelationId(c.relation_id)}
                />
                <span className="couple-modal-name">{c.name}</span>
              </label>
            ))
          )}
        </div>

        <div className="names-modal-footer">
          <button
            className="names-modal-save-btn"
            disabled={selectedRelationId === null || isSaving}
            onClick={handleOk}
          >
            {isSaving ? '処理中…' : 'OK'}
          </button>
          <button className="names-modal-cancel-btn" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
};

export default CoupleRouteModal;
