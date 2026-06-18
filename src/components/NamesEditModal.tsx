import React, { useState, useEffect } from 'react';
import DeleteIcon from '@mui/icons-material/Delete';
import ClearIcon from '@mui/icons-material/Clear';
import CloseIcon from '@mui/icons-material/Close';

interface NameEntry {
  value: string;
  is_global: boolean;
  locations: string[][];
  /** UI-only: marked for deletion */
  deleted: boolean;
  /** UI-only: newly added in this session */
  isNew: boolean;
}

interface NamesEditModalProps {
  relation_id: number;
  onClose: () => void;
  onSaved: () => void;
}

const NamesEditModal: React.FC<NamesEditModalProps> = ({
  relation_id,
  onClose,
  onSaved,
}) => {
  const [entries, setEntries] = useState<NameEntry[]>([]);
  const [originalNames, setOriginalNames] = useState<
    { value: string; is_global: boolean; locations: string[][] }[]
  >([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    fetch(`/api/routes/${relation_id}/names`)
      .then((r) => r.json())
      .then((names: { value: string; is_global?: boolean; locations?: string[][] }[]) => {
        const loaded: NameEntry[] = names.map((n) => ({
          value: n.value,
          is_global: n.is_global ?? true,
          locations: n.locations ?? [],
          deleted: false,
          isNew: false,
        }));
        setEntries(loaded);
        setOriginalNames(
          names.map((n) => ({
            value: n.value,
            is_global: n.is_global ?? true,
            locations: n.locations ?? [],
          }))
        );
      })
      .finally(() => setIsLoading(false));
  }, [relation_id]);

  // Names that will actually be saved (non-deleted entries)
  const finalNames = entries
    .filter((e) => !e.deleted)
    .map(({ value, is_global, locations }) => ({ value, is_global, locations }));

  const isDirty = JSON.stringify(finalNames) !== JSON.stringify(originalNames);
  const hasEmptyEnabled = finalNames.some((e) => !e.value.trim());
  const saveEnabled = isDirty && !hasEmptyEnabled && !isSaving;

  const update = (idx: number, patch: Partial<NameEntry>) =>
    setEntries((prev) => prev.map((e, i) => (i === idx ? { ...e, ...patch } : e)));

  const handleSave = async () => {
    setIsSaving(true);
    try {
      await fetch(`/api/routes/${relation_id}/names`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ names: finalNames }),
      });
      onSaved();
    } finally {
      setIsSaving(false);
    }
  };

  // Close when clicking the backdrop
  const handleBackdropClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) onClose();
  };

  return (
    <div className="names-modal-overlay" onClick={handleBackdropClick}>
      <div className="names-modal">
        <button className="names-modal-close" onClick={onClose} title="閉じる">
          <CloseIcon fontSize="small" />
        </button>

        <p className="names-modal-message">このルートの名前を編集します</p>

        {isLoading ? (
          <p className="names-modal-loading">読み込み中…</p>
        ) : (
          <>
            <div className="names-modal-list">
              {entries.map((entry, idx) => (
                <div
                  key={idx}
                  className={`names-modal-row${entry.deleted ? ' names-modal-row--deleted' : ''}`}
                >
                  <input
                    className="names-modal-input"
                    type="text"
                    value={entry.value}
                    disabled={entry.deleted}
                    onChange={(e) => update(idx, { value: e.target.value })}
                  />
                  <button
                    className={`names-modal-del-btn${entry.deleted ? ' names-modal-del-btn--clear' : ''}`}
                    onClick={() => update(idx, { deleted: !entry.deleted })}
                    title={entry.deleted ? '削除を取り消す' : '削除'}
                  >
                    {entry.deleted ? (
                      <ClearIcon fontSize="small" />
                    ) : (
                      <DeleteIcon fontSize="small" />
                    )}
                  </button>
                </div>
              ))}
            </div>

            <button
              className="names-modal-add-btn"
              onClick={() =>
                setEntries((prev) => [
                  ...prev,
                  { value: '', is_global: true, locations: [], deleted: false, isNew: true },
                ])
              }
            >
              + new name
            </button>

            <div className="names-modal-footer">
              <button
                className="names-modal-save-btn"
                disabled={!saveEnabled}
                onClick={handleSave}
              >
                {isSaving ? '保存中…' : 'save'}
              </button>
              <button className="names-modal-cancel-btn" onClick={onClose}>
                cancel
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
};

export default NamesEditModal;
