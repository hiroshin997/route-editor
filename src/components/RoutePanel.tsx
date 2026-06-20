import React from 'react';
import EditIcon from '@mui/icons-material/Edit';
import OpenWithIcon from '@mui/icons-material/OpenWith';
import ContentCutIcon from '@mui/icons-material/ContentCut';
import { RoutePolyline } from '../types/route';

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
}) => {
  const newRouteEnabled = citySelected && zoom >= 14;
  return (
    <div className="route-panel">
      <button
        className="new-route-open-btn"
        disabled={!newRouteEnabled}
        onClick={onNewRoute}
        title={!citySelected ? '市区町村を選択してください' : zoom < 14 ? 'ズームレベル14以上にしてください' : ''}
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
              className={`route-panel-item${isActive ? ' route-panel-item--active' : ''}`}
              onClick={() => onSelect(rp.index)}
            >
              <span className={`route-panel-index${isActive ? ' route-panel-index--active' : ''}`}>
                {rp.index}
              </span>
              <span className="route-panel-name">{rp.name}</span>
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
