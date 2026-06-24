import React, { useState, useRef, useCallback } from 'react';
import ReactDOM from 'react-dom';
import { Marker, Polyline, useMap, useMapEvents } from 'react-leaflet';
import L from 'leaflet';
import { Intersection, RoutePolyline } from '../types/route';

// ── Snap-to-polyline helpers ──────────────────────────────────────────────────

function closestPointOnSegment(
  pLat: number, pLon: number,
  aLat: number, aLon: number,
  bLat: number, bLon: number,
): [number, number, number] {
  const dx = bLon - aLon, dy = bLat - aLat;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-14) return [aLat, aLon, Math.hypot(pLat - aLat, pLon - aLon)];
  const t = Math.max(0, Math.min(1, ((pLon - aLon) * dx + (pLat - aLat) * dy) / lenSq));
  const cLat = aLat + t * dy, cLon = aLon + t * dx;
  return [cLat, cLon, Math.hypot(pLat - cLat, pLon - cLon)];
}

function snapToPolyline(
  pLat: number, pLon: number,
  roadItems: any[],
): { road_id: number; coord_index: number; lat: number; lon: number } | null {
  let minDist = Infinity;
  let result: { road_id: number; coord_index: number; lat: number; lon: number } | null = null;
  for (const road of roadItems) {
    for (const s of (road.road_sectors || [])) {
      const [cLat, cLon, dist] = closestPointOnSegment(pLat, pLon, s.lat0, s.lon0, s.lat1, s.lon1);
      if (dist < minDist) {
        minDist = dist;
        result = { road_id: road.road_id, coord_index: s.coord_index, lat: cLat, lon: cLon };
      }
    }
  }
  return result;
}

// ── Intersection marker icon ──────────────────────────────────────────────────

function createIntersectionIcon(name: string): L.DivIcon {
  const escaped = name.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const labelHtml = name
    ? `<div style="background:#fef08a;color:#000;border:1.5px solid #555;border-radius:2px;padding:1px 5px;font-size:11px;font-weight:bold;margin-left:3px;">${escaped}</div>`
    : '';
  return L.divIcon({
    className: 'intersection-icon',
    html: `<div style="display:flex;align-items:center;white-space:nowrap;pointer-events:all;">
      <div style="width:16px;height:22px;background:#f59e0b;border:1.5px solid #555;border-radius:3px;display:flex;flex-direction:column;align-items:center;justify-content:space-evenly;padding:2px;flex-shrink:0;">
        <div style="width:5px;height:5px;border-radius:50%;background:#ef4444;"></div>
        <div style="width:5px;height:5px;border-radius:50%;background:#fbbf24;"></div>
        <div style="width:5px;height:5px;border-radius:50%;background:#22c55e;"></div>
      </div>${labelHtml}
    </div>`,
    iconSize: [name ? 130 : 20, 24],
    iconAnchor: [8, 12],
  });
}

// ── Context menu and dialog types ─────────────────────────────────────────────

type CtxMenu =
  | { type: 'polyline'; x: number; y: number; snapResult: { road_id: number; coord_index: number; lat: number; lon: number } }
  | { type: 'marker';   x: number; y: number; intersection: Intersection }
  | null;

type Dialog =
  | { type: 'add-name';   snapResult: { road_id: number; coord_index: number; lat: number; lon: number } }
  | { type: 'rename';     intersection: Intersection }
  | { type: 'delete';     intersection: Intersection }
  | null;

// ── Main overlay component ────────────────────────────────────────────────────

export interface IntersectionOverlayProps {
  intersections: Intersection[];
  routePolyline: RoutePolyline | null;
  isEditMode: boolean;
  roadItems: any[];
  onAdd: (snap: { road_id: number; coord_index: number; lat: number; lon: number }, name: string) => void;
  onDelete: (id: number) => void;
  onRename: (id: number, name: string) => void;
  onMove: (id: number, snap: { road_id: number; coord_index: number; lat: number; lon: number }) => void;
}

const IntersectionOverlay: React.FC<IntersectionOverlayProps> = ({
  intersections,
  routePolyline,
  isEditMode,
  roadItems,
  onAdd,
  onDelete,
  onRename,
  onMove,
}) => {
  const map = useMap();
  const [ctxMenu, setCtxMenu] = useState<CtxMenu>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [nameInput, setNameInput] = useState('');
  const nameInputRef = useRef<HTMLInputElement>(null);

  console.log('[IntersectionOverlay] render: intersections=', intersections.length, 'isEditMode=', isEditMode);
  // Log positions of first 3 intersections to verify lat/lon
  if (intersections.length > 0) {
    console.log('[IntersectionOverlay] positions[0..2]:',
      intersections.slice(0, 3).map((i) => ({ id: i.intersection_id, lat: i.lat, lon: i.lon, name: i.name })));
  }

  // Close context menu on map click
  useMapEvents({ click: () => setCtxMenu(null) });

  const openDialog = useCallback((d: Dialog, initialName = '') => {
    setDialog(d);
    setNameInput(initialName);
    setTimeout(() => nameInputRef.current?.focus(), 50);
  }, []);

  // ── Marker events ────────────────────────────────────────────────────────────

  const handleMarkerContextMenu = useCallback((e: any, intersection: Intersection) => {
    if (!isEditMode) return;
    e.originalEvent.preventDefault();
    L.DomEvent.stopPropagation(e);
    const pt = map.latLngToContainerPoint(e.latlng);
    setCtxMenu({ type: 'marker', x: pt.x, y: pt.y, intersection });
  }, [isEditMode, map]);

  const handleDragEnd = useCallback((e: any, id: number) => {
    if (!isEditMode) return;
    const pos = e.target.getLatLng();
    const snap = snapToPolyline(pos.lat, pos.lng, roadItems);
    if (snap) {
      onMove(id, snap);
      e.target.setLatLng([snap.lat, snap.lon]);
    }
  }, [isEditMode, roadItems, onMove]);

  // ── Polyline right-click (add intersection) ───────────────────────────────────

  const handlePolylineContextMenu = useCallback((e: any) => {
    if (!isEditMode) return;
    e.originalEvent.preventDefault();
    L.DomEvent.stopPropagation(e);
    const snap = snapToPolyline(e.latlng.lat, e.latlng.lng, roadItems);
    if (snap) {
      const pt = map.latLngToContainerPoint(e.latlng);
      setCtxMenu({ type: 'polyline', x: pt.x, y: pt.y, snapResult: snap });
    }
  }, [isEditMode, roadItems, map]);

  // ── Context menu actions ─────────────────────────────────────────────────────

  const handleCtxAdd = () => {
    console.log('[handleCtxAdd] ctxMenu=', ctxMenu);
    if (ctxMenu?.type !== 'polyline') return;
    const snap = ctxMenu.snapResult;
    setCtxMenu(null);
    console.log('[handleCtxAdd] opening dialog, snap=', snap);
    openDialog({ type: 'add-name', snapResult: snap });
  };

  const handleCtxRename = () => {
    if (ctxMenu?.type !== 'marker') return;
    const inter = ctxMenu.intersection;
    setCtxMenu(null);
    openDialog({ type: 'rename', intersection: inter }, inter.name);
  };

  const handleCtxDelete = () => {
    if (ctxMenu?.type !== 'marker') return;
    const inter = ctxMenu.intersection;
    setCtxMenu(null);
    openDialog({ type: 'delete', intersection: inter });
  };

  // ── Dialog confirms ──────────────────────────────────────────────────────────

  const handleDialogOk = () => {
    console.log('[handleDialogOk] called, dialog=', dialog, 'nameInput=', nameInput);
    if (!dialog) return;
    if (dialog.type === 'add-name') {
      onAdd(dialog.snapResult, nameInput);
    } else if (dialog.type === 'rename') {
      onRename(dialog.intersection.intersection_id, nameInput);
    } else if (dialog.type === 'delete') {
      onDelete(dialog.intersection.intersection_id);
    }
    setDialog(null);
    setNameInput('');
  };

  const handleDialogCancel = () => {
    setDialog(null);
    setNameInput('');
  };

  const mapContainer = map.getContainer();

  return (
    <>
      {/* Invisible thick polyline for right-click detection in edit mode */}
      {isEditMode && routePolyline && routePolyline.coords.length > 0 && (
        <Polyline
          positions={routePolyline.coords}
          pathOptions={{ color: 'transparent', weight: 20, opacity: 0.01 }}
          eventHandlers={{ contextmenu: handlePolylineContextMenu }}
        />
      )}

      {/* Intersection markers */}
      {intersections.map((inter) => {
        const pos: [number, number] = [Number(inter.lat), Number(inter.lon)];
        if (isNaN(pos[0]) || isNaN(pos[1])) {
          console.warn('[IntersectionOverlay] invalid position for', inter.intersection_id, pos);
          return null;
        }
        return (
          <Marker
            key={inter.intersection_id}
            position={pos}
            icon={createIntersectionIcon(inter.name)}
            draggable={isEditMode}
            eventHandlers={{
              contextmenu: (e) => handleMarkerContextMenu(e, inter),
              dragend: (e) => handleDragEnd(e, inter.intersection_id),
            }}
          />
        );
      })}

      {/* Context menu */}
      {ctxMenu && ReactDOM.createPortal(
        <div
          className="intersection-ctx-menu"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
          ref={(el) => { if (el) L.DomEvent.disableClickPropagation(el); }}
          onContextMenu={(e) => e.preventDefault()}
        >
          {ctxMenu.type === 'polyline' && (
            <div className="ctx-menu-item" onClick={() => {
              console.log('[ctx-menu] 交差点の追加 clicked, snapResult=', ctxMenu.type === 'polyline' ? ctxMenu.snapResult : null);
              handleCtxAdd();
            }}>交差点の追加</div>
          )}
          {ctxMenu.type === 'marker' && (
            <>
              <div className="ctx-menu-item" onClick={handleCtxRename}>交差点名の変更</div>
              <div className="ctx-menu-item" onClick={handleCtxDelete}>交差点の削除</div>
            </>
          )}
        </div>,
        mapContainer,
      )}

      {/* Dialogs – rendered into document.body to avoid Leaflet event interference */}
      {dialog && ReactDOM.createPortal(
        <div
          className="intersection-dialog-backdrop"
          onClick={(e) => { if (e.target === e.currentTarget) handleDialogCancel(); }}
        >
          <div className="intersection-dialog" onClick={(e) => e.stopPropagation()}>
            {dialog.type === 'delete' ? (
              <>
                <p className="intersection-dialog-msg">
                  この交差点を削除します。よろしいですか？
                </p>
                <div className="intersection-dialog-buttons">
                  <button className="intersection-dialog-ok" onClick={handleDialogOk}>ok</button>
                  <button className="intersection-dialog-cancel" onClick={handleDialogCancel}>cancel</button>
                </div>
              </>
            ) : (
              <>
                <p className="intersection-dialog-msg">交差点名を指定してください</p>
                <input
                  ref={nameInputRef}
                  type="text"
                  className="intersection-dialog-input"
                  value={nameInput}
                  onChange={(e) => setNameInput(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleDialogOk()}
                  placeholder="交差点名"
                />
                <div className="intersection-dialog-buttons">
                  <button className="intersection-dialog-ok" onClick={handleDialogOk}>ok</button>
                  <button className="intersection-dialog-cancel" onClick={handleDialogCancel}>cancel</button>
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

export default IntersectionOverlay;
