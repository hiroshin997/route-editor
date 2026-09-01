import React from 'react';
import ReactDOM from 'react-dom';
import { Marker, Polyline } from 'react-leaflet';
import L from 'leaflet';
import { LinkModeState } from '../types/route';

const LINK_ICON_HTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="52" height="52" fill="#2563eb">
  <path d="M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7c-2.76 0-5 2.24-5 5s2.24 5 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zM8 13h8v-2H8v2zm9-6h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4c2.76 0 5-2.24 5-5s-2.24-5-5-5z"/>
</svg>`;

const linkIcon = L.divIcon({
  className: 'route-link-marker-icon',
  html: LINK_ICON_HTML,
  iconSize: [52, 52],
  iconAnchor: [26, 26],
});

export interface RouteLinkOverlayProps {
  linkMode: LinkModeState | null;
  onEndpointClick: (endpoint: 'start' | 'end') => void;
  onSelectCandidate: (relation_id: number) => void;
  onConfirmLink: () => void;
  onDismissModal: () => void;
  onCancelLink: () => void;
}

const RouteLinkOverlay: React.FC<RouteLinkOverlayProps> = ({
  linkMode,
  onEndpointClick,
  onSelectCandidate,
  onConfirmLink,
  onDismissModal,
  onCancelLink,
}) => {
  if (!linkMode) return null;

  const { startPos, endPos, status, candidates, selectedCandidateRelationId } = linkMode;
  const showModal = status === 'done';
  const showCandidateLines = showModal && candidates && candidates.length >= 1 && candidates.length <= 4;

  return (
    <>
      {/* Start and end LinkIcon markers */}
      <Marker position={startPos} icon={linkIcon} eventHandlers={{ click: () => onEndpointClick('start') }} />
      <Marker position={endPos} icon={linkIcon} eventHandlers={{ click: () => onEndpointClick('end') }} />

      {/* Candidate route polylines (blue dotted blink) */}
      {showCandidateLines && candidates!.map((c) => (
        <Polyline
          key={`link-cand-${c.relation_id}-${c.path_idx}`}
          positions={c.coords}
          pathOptions={{ color: '#2563eb', weight: 3, dashArray: '10 6', className: 'link-candidate-line' }}
        />
      ))}

      {/* Result modal */}
      {showModal && ReactDOM.createPortal(
        <div className="intersection-dialog-backdrop">
          <div className="intersection-dialog link-modal" onClick={(e) => e.stopPropagation()}>
            {!candidates || candidates.length === 0 ? (
              // 4.1: no candidates
              <>
                <p className="intersection-dialog-msg">接続可能な route が見つかりません</p>
                <div className="intersection-dialog-buttons">
                  <button className="intersection-dialog-ok" onClick={onDismissModal}>OK</button>
                </div>
              </>
            ) : candidates.length >= 5 ? (
              // 4.3: too many
              <>
                <p className="intersection-dialog-msg">
                  接続可能な route が多すぎて接続できません（{candidates.length}件）
                </p>
                <div className="intersection-dialog-buttons">
                  <button className="intersection-dialog-ok" onClick={onDismissModal}>OK</button>
                </div>
              </>
            ) : (
              // 4.2: 1-4 candidates
              <>
                <p className="intersection-dialog-msg">
                  接続可能な以下の routes が見つかりました。選択してください。
                </p>
                <div className="link-candidate-list">
                  {candidates.map((c) => (
                    <label key={`${c.relation_id}-${c.path_idx}`} className="link-candidate-item">
                      <input
                        type="radio"
                        name="link-candidate"
                        checked={selectedCandidateRelationId === c.relation_id}
                        onChange={() => onSelectCandidate(c.relation_id)}
                      />
                      <span>{`${c.relation_id}: ${c.name}`}{c.reverse ? '（逆向き接続）' : ''}</span>
                    </label>
                  ))}
                </div>
                <div className="intersection-dialog-buttons">
                  <button
                    className="intersection-dialog-ok"
                    disabled={!selectedCandidateRelationId}
                    onClick={onConfirmLink}
                  >
                    OK
                  </button>
                  <button className="intersection-dialog-cancel" onClick={onCancelLink}>Cancel</button>
                </div>
              </>
            )}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
};

export default RouteLinkOverlay;
