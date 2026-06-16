import React from 'react';
import { RoutePolyline } from '../types/route';

interface RoutePanelProps {
  routePolylines: RoutePolyline[];
}

const RoutePanel: React.FC<RoutePanelProps> = ({ routePolylines }) => {
  return (
    <div className="route-panel">
      {routePolylines.length === 0 ? (
        <p className="route-panel-empty">市区町村を選択するとルートが表示されます</p>
      ) : (
        routePolylines.map((rp) => (
          <div key={rp.index} className="route-panel-item">
            <span className="route-panel-index">{rp.index}</span>
            <span className="route-panel-name">{rp.name}</span>
          </div>
        ))
      )}
    </div>
  );
};

export default RoutePanel;
