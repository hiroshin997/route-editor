import React from 'react';
import CloseIcon from '@mui/icons-material/Close';

interface IntersectionPanelProps {
  isDirty: boolean;
  isSaving: boolean;
  onSave: () => void;
  onCancel: () => void;
  onClose: () => void;
}

const IntersectionPanel: React.FC<IntersectionPanelProps> = ({
  isDirty,
  isSaving,
  onSave,
  onCancel,
  onClose,
}) => (
  <div className="intersection-panel">
    <div className="intersection-panel-header">
      <span className="intersection-panel-title">交差点編集</span>
      <button className="intersection-panel-close" onClick={onClose} title="閉じる">
        <CloseIcon fontSize="small" />
      </button>
    </div>
    <div className="intersection-panel-buttons">
      <button
        className="intersection-panel-btn intersection-panel-save-btn"
        disabled={!isDirty || isSaving}
        onClick={onSave}
      >
        {isSaving ? '保存中…' : 'save'}
      </button>
      <button className="intersection-panel-btn intersection-panel-cancel-btn" onClick={onCancel}>
        cancel
      </button>
    </div>
  </div>
);

export default IntersectionPanel;
