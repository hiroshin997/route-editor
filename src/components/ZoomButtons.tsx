import React from 'react';

const ZOOM_MIN = 5;
const ZOOM_MAX = 21;

interface ZoomButtonsProps {
  zoom: number;
  onZoomChange: (zoom: number) => void;
}

const ZoomButtons: React.FC<ZoomButtonsProps> = ({ zoom, onZoomChange }) => {
  const levels = Array.from(
    { length: ZOOM_MAX - ZOOM_MIN + 1 },
    (_, i) => i + ZOOM_MIN
  );

  return (
    <div className="zoom-buttons-area">
      <span className="zoom-label">Map</span>
      <span className="zoom-label">Zoom</span>
      {levels.map((level) => (
        <button
          key={level}
          className={`zoom-btn${zoom === level ? ' zoom-btn--active' : ''}`}
          onClick={() => onZoomChange(level)}
        >
          {level}
        </button>
      ))}
    </div>
  );
};

export default ZoomButtons;
