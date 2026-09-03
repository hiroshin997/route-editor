import React, { useEffect, useRef } from 'react';
import EditIcon from '@mui/icons-material/Edit';
import OpenWithIcon from '@mui/icons-material/OpenWith';
import ContentCutIcon from '@mui/icons-material/ContentCut';
import LinkIcon from '@mui/icons-material/Link';
import TrafficIcon from '@mui/icons-material/Traffic';
import MergeIcon from '@mui/icons-material/Merge';
import LoopIcon from '@mui/icons-material/Loop';
import { RoutePolyline } from '../types/route';

// route-panel は表示切り替えで unmount されるため、スクロール位置はモジュールスコープで保持する。
// onScroll で常時更新しておき、unmount時に scrollTop を読み直さない
// (Firefox は要素が DOM から外れると scrollTop が 0 にリセットされるため)。
let savedScrollTop = 0;

interface RoutePanelProps {
  routePolylines: RoutePolyline[];
  hoveredIndex: number | null;
  selectedIndex: number | null;
  zoom: number;
  citySelected: boolean;
  onSelect: (index: number | null) => void;
  onNewRoute: () => void;
  onEditNames: (relation_id: number) => void;
  onExtendRoute: (relation_id: number) => void;
  extendingRelationId?: number;
  onTrimRoute: (relation_id: number, path_idx: number) => void;
  trimmingRelationId?: number;
  onSectorTrimRoute: (relation_id: number, path_idx: number) => void;
  sectorTrimmingRelationId?: number;
  onLinkRoute: (relation_id: number, path_idx: number) => void;
  linkingRelationId?: number;
  onIntersectionRoute: (relation_id: number, path_idx: number) => void;
  intersectionRelationId?: number;
  onCoupleRoute: (relation_id: number) => void;
}

const RoutePanel: React.FC<RoutePanelProps> = ({
  routePolylines,
  hoveredIndex,
  selectedIndex,
  zoom,
  citySelected,
  onSelect,
  onNewRoute,
  onEditNames,
  onExtendRoute,
  extendingRelationId,
  onTrimRoute,
  trimmingRelationId,
  onSectorTrimRoute,
  sectorTrimmingRelationId,
  onLinkRoute,
  linkingRelationId,
  onIntersectionRoute,
  intersectionRelationId,
  onCoupleRoute,
}) => {
  const newRouteEnabled = citySelected && zoom >= 10;
  // relation_id → number of paths currently listed for that route. A route with
  // two paths can't be coupled again, so its MergeIcon is disabled.
  const pathCountByRelation = new Map<number, number>();
  for (const rp of routePolylines) {
    if (rp.relation_id === undefined) continue;
    pathCountByRelation.set(rp.relation_id, (pathCountByRelation.get(rp.relation_id) ?? 0) + 1);
  }
  const scrollRef = useRef<HTMLDivElement>(null);
  const selectedItemRef = useRef<HTMLDivElement>(null);
  // Tracks the selection we last auto-scrolled to, so a manual scroll away from
  // an unchanged selection isn't yanked back on every re-render.
  const scrolledToIndexRef = useRef<number | null>(null);

  useEffect(() => {
    // Restore the previous scroll position on (re)mount — but not when a route is
    // already selected: the effect below owns scrolling to that row (e.g. right
    // after a "new route" save, which remounts this panel then selects path 0).
    if (scrollRef.current && selectedIndex === null) {
      scrollRef.current.scrollTop = savedScrollTop;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Scroll the selected route into view when the selection changes — covers
  // picking a route on the map, landing on a /address/..?relation_id=&path= deep
  // link, and the freshly-created route after [new route] save. In that last
  // case the panel has just remounted and the route list is still settling, so
  // the target row may not be in the DOM on the commit the selection lands —
  // retry over the next few frames until it's there.
  useEffect(() => {
    if (selectedIndex === null) {
      scrolledToIndexRef.current = null;
      return;
    }
    if (selectedIndex === scrolledToIndexRef.current) return;

    let raf = 0;
    const attempt = (tries: number) => {
      const el =
        selectedItemRef.current ??
        scrollRef.current?.querySelector<HTMLElement>('[data-route-selected="true"]') ??
        null;
      if (el) {
        el.scrollIntoView({ block: 'nearest' });
        scrolledToIndexRef.current = selectedIndex;
      } else if (tries < 10) {
        raf = requestAnimationFrame(() => attempt(tries + 1));
      }
    };
    attempt(0);
    return () => { if (raf) cancelAnimationFrame(raf); };
  }, [selectedIndex, routePolylines]);

  return (
    <div
      className="route-panel"
      ref={scrollRef}
      onScroll={(e) => {
        savedScrollTop = e.currentTarget.scrollTop;
      }}
    >
      <button
        className="new-route-open-btn"
        disabled={!newRouteEnabled}
        onClick={onNewRoute}
        title={!citySelected ? '市区町村を選択してください' : zoom < 10 ? 'ズームレベル10以上にしてください' : ''}
      >
        ＋ new route
      </button>
      {routePolylines.length === 0 ? (
        <p className="route-panel-empty">市区町村を選択するとルートが表示されます</p>
      ) : (
        routePolylines.map((rp) => {
          const isActive = rp.index === selectedIndex || rp.index === hoveredIndex;
          return (
            <div
              key={rp.index}
              ref={rp.index === selectedIndex ? selectedItemRef : undefined}
              data-route-selected={rp.index === selectedIndex ? 'true' : undefined}
              className={`route-panel-item${isActive ? ' route-panel-item--active' : ''}`}
              onClick={() => onSelect(rp.index)}
            >
              <span className={`route-panel-index${isActive ? ' route-panel-index--active' : ''}`}>
                {rp.index}
              </span>
              <span className="route-panel-name">
                {rp.name}
                {rp.is_loop && <LoopIcon fontSize="small" className="route-panel-loop-icon" />}
              </span>
              {rp.relation_id !== undefined && (
                <>
                  <button
                    className="route-panel-edit-btn"
                    title="名前を編集"
                    onClick={(e) => { e.stopPropagation(); onEditNames(rp.relation_id!); }}
                  >
                    <EditIcon fontSize="small" />
                  </button>
                  <button
                    className={`route-panel-edit-btn route-panel-extend-btn${extendingRelationId === rp.relation_id ? ' route-panel-extend-btn--active' : ''}`}
                    title="経路を延長"
                    onClick={(e) => { e.stopPropagation(); onExtendRoute(rp.relation_id!); }}
                  >
                    <OpenWithIcon fontSize="small" />
                  </button>
                  <button
                    className={`route-panel-edit-btn route-panel-trim-btn${trimmingRelationId === rp.relation_id ? ' route-panel-trim-btn--active' : ''}`}
                    title="経路を剪定"
                    disabled={(rp.road_count ?? 2) <= 1}
                    onClick={(e) => { e.stopPropagation(); onTrimRoute(rp.relation_id!, rp.path_idx ?? 0); }}
                  >
                    <ContentCutIcon fontSize="small" />
                  </button>
                  <button
                    className={`route-panel-edit-btn route-panel-sector-trim-btn${sectorTrimmingRelationId === rp.relation_id ? ' route-panel-sector-trim-btn--active' : ''}`}
                    title="経路を sector 単位で剪定"
                    onClick={(e) => { e.stopPropagation(); onSectorTrimRoute(rp.relation_id!, rp.path_idx ?? 0); }}
                  >
                    <ContentCutIcon sx={{ fontSize: 15 }} />
                  </button>
                  <button
                    className={`route-panel-edit-btn route-panel-link-btn${linkingRelationId === rp.relation_id ? ' route-panel-link-btn--active' : ''}`}
                    title="ルートを接続"
                    onClick={(e) => { e.stopPropagation(); onLinkRoute(rp.relation_id!, rp.path_idx ?? 0); }}
                  >
                    <LinkIcon fontSize="small" />
                  </button>
                  <button
                    className={`route-panel-edit-btn route-panel-intersection-btn${intersectionRelationId === rp.relation_id ? ' route-panel-intersection-btn--active' : ''}`}
                    title="交差点編集"
                    onClick={(e) => { e.stopPropagation(); onIntersectionRoute(rp.relation_id!, rp.path_idx ?? 0); }}
                  >
                    <TrafficIcon fontSize="small" />
                  </button>
                  <button
                    className="route-panel-edit-btn route-panel-merge-btn"
                    title={(pathCountByRelation.get(rp.relation_id!) ?? 1) >= 2
                      ? 'このルートは既に2つのパスを持っています'
                      : 'ルートをカップリング'}
                    disabled={(pathCountByRelation.get(rp.relation_id!) ?? 1) >= 2}
                    onClick={(e) => { e.stopPropagation(); onCoupleRoute(rp.relation_id!); }}
                  >
                    <MergeIcon fontSize="small" />
                  </button>
                </>
              )}
            </div>
          );
        })
      )}
    </div>
  );
};

export default RoutePanel;
