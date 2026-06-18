import React from 'react';
import { RoutePolyline } from '../types/route';

interface RoutePanelProps {
  routePolylines: RoutePolyline[];
  hoveredIndex: number | null;
  selectedIndex: number | null;
  zoom: number;
  citySelected: boolean;
  onSelect: (index: number | null) => void;
  onNewRoute: () => void;
}

const RoutePanel: React.FC<RoutePanelProps> = ({
  routePolylines,
  hoveredIndex,
  selectedIndex,
  zoom,
  citySelected,
  onSelect,
  onNewRoute,
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
            </div>
          );
        })
      )}
    </div>
  );
};

export default RoutePanel;
