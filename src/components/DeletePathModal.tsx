import React, { useState } from 'react';
import CloseIcon from '@mui/icons-material/Close';

interface DeletePathModalProps {
  relation_id: number;
  route_name: string;
  /** Index in doc.routes[] of the path to delete. */
  path_idx: number;
  onClose: () => void;
  onDeleted: () => void;
}

/**
 * Confirmation modal for the right-panel DeleteIcon. On OK, removes
 * routes[path_idx] from the route — or hard-deletes the whole route document
 * when that path is its only one (decided server-side).
 */
const DeletePathModal: React.FC<DeletePathModalProps> = ({
  relation_id,
  route_name,
  path_idx,
  onClose,
  onDeleted,
}) => {
  const [isSaving, setIsSaving] = useState(false);

  const handleOk = async () => {
    setIsSaving(true);
    try {
      const res = await fetch(`/api/routes/${relation_id}/paths/${path_idx}`, { method: 'DELETE' });
      if (res.ok) {
        onDeleted();
      } else {
        console.error('[DeletePathModal] server error:', await res.text());
      }
    } finally {
      setIsSaving(false);
    }
  };

  const handleBackdropClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget && !isSaving) onClose();
  };

  return (
    <div className="names-modal-overlay" onClick={handleBackdropClick}>
      <div className="names-modal">
        <button className="names-modal-close" onClick={onClose} disabled={isSaving} title="閉じる">
          <CloseIcon fontSize="small" />
        </button>

        <p className="names-modal-message">
          {`[${route_name}]@path=${path_idx} は削除されます。削除すると復元することはできません。よろしいですか？`}
        </p>

        <div className="names-modal-footer">
          <button className="names-modal-save-btn" disabled={isSaving} onClick={handleOk}>
            {isSaving ? '処理中…' : 'OK'}
          </button>
          <button className="names-modal-cancel-btn" disabled={isSaving} onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
};

export default DeletePathModal;
