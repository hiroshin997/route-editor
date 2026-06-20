import React, { useState, useEffect, useRef } from 'react';
import ReactDOM from 'react-dom';
import { Marker, Polyline, useMap, useMapEvents } from 'react-leaflet';
import L from 'leaflet';
import {
  EndpointInfo,
  RoadArrow,
  ExtendModeState,
  ExtendModalState,
} from '../types/route';

// ── Endpoint marker icon (orange OpenWith-style) ──────────────────────────────

const endpointIcon = L.divIcon({
  className: 'endpoint-marker-icon',
  html: `<svg xmlns="http://www.w3.org/2000/svg" width="30" height="30" viewBox="0 0 24 24" fill="#f97316" stroke="white" stroke-width="0.5">
    <path d="m12 2-4 4h3v3H8V6L4 10l4 4v-3h3v3H8l4 4 4-4h-3v-3h3v3l4-4-4-4v3h-3V9h3l-4-4z"/>
  </svg>`,
  iconSize: [30, 30],
  iconAnchor: [15, 15],
});

// ── SVG Arrow component ────────────────────────────────────────────────────────

const SVG_SIZE = 220;
const HALF = SVG_SIZE / 2;
const ARROW_LEN = 82;
const HEAD_LEN = 13;
const HEAD_SPREAD = 0.45; // ~26° — wings extend back toward center

function ArrowPath({
  arrow,
  selected,
  onClick,
}: {
  arrow: RoadArrow;
  selected: boolean;
  onClick: () => void;
}) {
  const rad = (arrow.bearing * Math.PI) / 180;
  const ex = HALF + ARROW_LEN * Math.sin(rad);
  const ey = HALF - ARROW_LEN * Math.cos(rad);
  const angle = Math.atan2(ey - HALF, ex - HALF);
  const h1x = ex + HEAD_LEN * Math.cos(angle + Math.PI - HEAD_SPREAD);
  const h1y = ey + HEAD_LEN * Math.sin(angle + Math.PI - HEAD_SPREAD);
  const h2x = ex + HEAD_LEN * Math.cos(angle + Math.PI + HEAD_SPREAD);
  const h2y = ey + HEAD_LEN * Math.sin(angle + Math.PI + HEAD_SPREAD);
  const color = selected ? '#2563eb' : '#f97316';

  return (
    <g onClick={onClick} style={{ cursor: 'pointer' }}>
      {/* Wide transparent hit area */}
      <line x1={HALF} y1={HALF} x2={ex} y2={ey} stroke="transparent" strokeWidth={18} />
      {/* Arrow shaft */}
      <line x1={HALF} y1={HALF} x2={ex} y2={ey} stroke={color} strokeWidth={selected ? 4 : 3} />
      {/* Arrowhead */}
      <polygon points={`${ex},${ey} ${h1x},${h1y} ${h2x},${h2y}`} fill={color} />
    </g>
  );
}

// ── Extend modal div (portal into map container) ──────────────────────────────

function ExtendModalDiv({
  modal,
  pixelPos,
  pendingCount,
  onArrowSelect,
  onForward,
  onSaveAndClose,
  onCancel,
  mapContainer,
}: {
  modal: ExtendModalState;
  pixelPos: { x: number; y: number };
  pendingCount: number;
  onArrowSelect: (roadId: number) => void;
  onForward: () => void;
  onSaveAndClose: () => void;
  onCancel: () => void;
  mapContainer: HTMLElement;
}) {
  const stop = (e: React.SyntheticEvent) => {
    e.stopPropagation();
    (e.nativeEvent as Event).stopPropagation();
  };

  const content = (
    <div
      className="extend-modal"
      style={{ left: pixelPos.x - HALF, top: pixelPos.y - HALF }}
      onClick={stop}
      onMouseDown={stop}
      onPointerDown={stop}
      onDoubleClick={stop}
      onWheel={stop}
    >
      {/* Close button */}
      <button className="extend-modal-close" onClick={onCancel} title="閉じる">
        ✕
      </button>

      {/* Arrow SVG or loading spinner */}
      {modal.arrows === null ? (
        <div
          style={{
            width: SVG_SIZE,
            height: SVG_SIZE,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <div className="extend-modal-spinner" />
        </div>
      ) : (
        <svg
          width={SVG_SIZE}
          height={SVG_SIZE}
          style={{ display: 'block' }}
          onClick={stop}
        >
          <circle cx={HALF} cy={HALF} r={7} fill="#2563eb" stroke="white" strokeWidth={2} />
          {modal.arrows.map((arrow) => (
            <ArrowPath
              key={`${arrow.road_id}-${arrow.direction}`}
              arrow={arrow}
              selected={modal.selected_road_id === arrow.road_id}
              onClick={() => onArrowSelect(arrow.road_id)}
            />
          ))}
        </svg>
      )}

      {/* Buttons */}
      <div className="extend-modal-buttons">
        <button
          className="extend-modal-btn extend-modal-btn-save"
          disabled={pendingCount === 0 || modal.arrows === null}
          onClick={onSaveAndClose}
        >
          save &amp; close
        </button>
        <button
          className="extend-modal-btn extend-modal-btn-forward"
          disabled={modal.selected_road_id === null || modal.arrows === null}
          onClick={onForward}
        >
          forward
        </button>
        <button className="extend-modal-btn extend-modal-btn-cancel" onClick={onCancel}>
          cancel
        </button>
      </div>
    </div>
  );

  return ReactDOM.createPortal(content, mapContainer);
}

// ── Main overlay component (must be inside MapContainer) ─────────────────────

export interface ExtendRouteOverlayProps {
  extendMode: ExtendModeState | null;
  onEndpointClick: (ep: EndpointInfo) => void;
  onArrowSelect: (roadId: number) => void;
  onForward: () => void;
  onSaveAndClose: () => void;
  onCancelExtend: () => void;
}

const ExtendRouteOverlay: React.FC<ExtendRouteOverlayProps> = ({
  extendMode,
  onEndpointClick,
  onArrowSelect,
  onForward,
  onSaveAndClose,
  onCancelExtend,
}) => {
  const map = useMap();
  const [modalPixelPos, setModalPixelPos] = useState<{ x: number; y: number } | null>(null);

  // Keep a ref to the latest update function to avoid stale closures in event handlers
  const updateRef = useRef<() => void>(() => {});
  // Only update position; never clear from map events (clearing is handled by useEffect below).
  updateRef.current = () => {
    if (!extendMode?.modal) return;
    const [lat, lon] = extendMode.modal.position;
    const pt = map.latLngToContainerPoint([lat, lon]);
    setModalPixelPos({ x: Math.round(pt.x), y: Math.round(pt.y) });
  };

  useEffect(() => {
    if (!extendMode?.modal) {
      // Modal intentionally closed – clear pixel position
      setModalPixelPos(null);
      return;
    }
    updateRef.current();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [extendMode?.modal?.position]);

  useMapEvents({
    move:    () => updateRef.current(),
    zoom:    () => updateRef.current(),
    moveend: () => updateRef.current(),
    zoomend: () => updateRef.current(),
  });

  if (!extendMode) return null;

  return (
    <>
      {/* Orange endpoint markers */}
      {extendMode.endpoints.map((ep, i) => (
        <Marker
          key={`ep-${i}-${ep.path_idx}-${ep.endpoint}`}
          position={[ep.lat, ep.lon]}
          icon={endpointIcon}
          eventHandlers={{
            click: (e) => {
              L.DomEvent.stopPropagation(e);
              onEndpointClick(ep);
            },
          }}
        />
      ))}

      {/* Pending roads: red dotted polylines */}
      {extendMode.pending_roads.map((pr, i) => (
        <Polyline
          key={`pending-${i}`}
          positions={pr.coords}
          pathOptions={{ color: 'red', weight: 3, dashArray: '8 6' }}
        />
      ))}

      {/* Arrow-selection modal */}
      {extendMode.modal && modalPixelPos && (
        <ExtendModalDiv
          modal={extendMode.modal}
          pixelPos={modalPixelPos}
          pendingCount={extendMode.pending_roads.length}
          onArrowSelect={onArrowSelect}
          onForward={onForward}
          onSaveAndClose={onSaveAndClose}
          onCancel={onCancelExtend}
          mapContainer={map.getContainer()}
        />
      )}
    </>
  );
};

export default ExtendRouteOverlay;
