import React from 'react';
import CloseIcon from '@mui/icons-material/Close';

interface TrimRoutePanelProps {
  isDirty: boolean;
  isSaving: boolean;
  onSave: () => void;
  onCancel: () => void;
  onClose: () => void;
}

const TrimRoutePanel: React.FC<TrimRoutePanelProps> = ({
  isDirty,
  isSaving,
  onSave,
  onCancel,
  onClose,
}) => (
  <div className="trim-route-panel">
    <div className="trim-route-panel-header">
      <span className="trim-route-panel-title">ルート剪定</span>
      <button className="trim-route-panel-close" onClick={onClose} title="閉じる">
        <CloseIcon fontSize="small" />
      </button>
    </div>
    <div className="trim-route-panel-buttons">
      <button
        className="trim-route-btn trim-route-save-btn"
        disabled={!isDirty || isSaving}
        onClick={onSave}
      >
        {isSaving ? '保存中…' : 'save'}
      </button>
      <button className="trim-route-btn trim-route-cancel-btn" onClick={onCancel}>
        cancel
      </button>
    </div>
  </div>
);

export default TrimRoutePanel;
