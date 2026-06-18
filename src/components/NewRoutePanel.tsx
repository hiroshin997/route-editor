import React, { useState } from 'react';
import { BBox, RouteDoc, RoutePolyline } from '../types/route';
import { computeRoutePolylines } from '../utils/routeUtils';

interface SearchResult {
  roadNames: string[];
  existingRoutes: { relation_id: number; name: string }[];
}

interface PreviewData {
  routes: any[][];
  bbox: BBox;
  highway_stat: Record<string, unknown>;
  names: { value: string; is_global: boolean; locations: string[][] }[];
}

interface NewRoutePanelProps {
  cityBbox: BBox | null;
  /** Current displayed route polylines (for finding 3.2 match by relation_id) */
  routePolylines: RoutePolyline[];
  onClose: () => void;
  /** Called whenever preview polylines change (pass [] to clear) */
  onPreviewRoutes: (routes: RoutePolyline[]) => void;
  /** Called when user selects an existing route (3.4): highlight it and close */
  onExistingRouteSelect: (index: number) => void;
  /** Called after a route is saved; triggers route list reload */
  onSaved: () => void;
}

const NewRoutePanel: React.FC<NewRoutePanelProps> = ({
  cityBbox,
  routePolylines,
  onClose,
  onPreviewRoutes,
  onExistingRouteSelect,
  onSaved,
}) => {
  const [query, setQuery] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  const [searchResult, setSearchResult] = useState<SearchResult | null>(null);
  const [selectedRoadName, setSelectedRoadName] = useState<string | null>(null);
  const [previewData, setPreviewData] = useState<PreviewData | null>(null);
  const [isBuildingRoute, setIsBuildingRoute] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  const handleClose = () => {
    onPreviewRoutes([]);
    onClose();
  };

  const handleSearch = async () => {
    if (!query.trim() || !cityBbox) return;
    setIsSearching(true);
    setSearchResult(null);
    setSelectedRoadName(null);
    setPreviewData(null);
    onPreviewRoutes([]);
    try {
      const bboxParams =
        `minLon=${cityBbox.minLon}&minLat=${cityBbox.minLat}` +
        `&maxLon=${cityBbox.maxLon}&maxLat=${cityBbox.maxLat}`;
      const q = encodeURIComponent(query.trim());
      const [roadNamesRes, existingRes] = await Promise.all([
        fetch(`/api/roads/search-names?q=${q}&${bboxParams}`),
        fetch(`/api/routes/search-by-name?q=${q}&${bboxParams}`),
      ]);
      const roadNamesRaw: string[] = await roadNamesRes.json();
      const existingRoutes: { relation_id: number; name: string }[] = await existingRes.json();

      // Exclude road names that are already registered as routes (case-insensitive)
      const existingNameSet = new Set(existingRoutes.map((r) => r.name.toLowerCase()));
      const roadNames = roadNamesRaw.filter((n) => !existingNameSet.has(n.toLowerCase()));

      setSearchResult({ roadNames, existingRoutes });
    } catch (e) {
      console.error('[NewRoutePanel] search error:', e);
    } finally {
      setIsSearching(false);
    }
  };

  const handleRoadNameClick = async (roadName: string) => {
    if (!cityBbox) return;
    setSelectedRoadName(roadName);
    setPreviewData(null);
    onPreviewRoutes([]);
    setIsBuildingRoute(true);
    try {
      const res = await fetch('/api/routes/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roadName, cityBbox }),
      });
      const data: PreviewData = await res.json();
      setPreviewData(data);
      if (data.routes.length > 0) {
        const fakeDoc: RouteDoc = {
          relation_id: 0,
          name: roadName,
          routes: data.routes as any,
        };
        onPreviewRoutes(computeRoutePolylines([fakeDoc], data.bbox));
      }
    } catch (e) {
      console.error('[NewRoutePanel] preview error:', e);
    } finally {
      setIsBuildingRoute(false);
    }
  };

  const handleCancel = () => {
    setSelectedRoadName(null);
    setPreviewData(null);
    onPreviewRoutes([]);
  };

  const handleSave = async () => {
    if (!previewData) return;
    setIsSaving(true);
    try {
      await fetch('/api/routes/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(previewData),
      });
      onPreviewRoutes([]);
      onSaved();
      onClose();
    } catch (e) {
      console.error('[NewRoutePanel] save error:', e);
    } finally {
      setIsSaving(false);
    }
  };

  const handleExistingRouteClick = (existing: { relation_id: number; name: string }) => {
    const match = routePolylines.find((rp) => rp.relation_id === existing.relation_id);
    if (match) onExistingRouteSelect(match.index);
    handleClose();
  };

  return (
    <div className="new-route-panel">
      {/* Header */}
      <div className="new-route-panel-header">
        <span className="new-route-panel-title">新規ルート登録</span>
        <button className="new-route-close-btn" onClick={handleClose} title="閉じる">✕</button>
      </div>

      {/* Search row */}
      <div className="new-route-search-row">
        <input
          className="new-route-input"
          type="text"
          placeholder="ルート名を入力してください"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
        />
        <button
          className="new-route-search-btn"
          onClick={handleSearch}
          disabled={isSearching || !query.trim()}
        >
          {isSearching ? '…' : '検索'}
        </button>
      </div>

      {/* Results */}
      {searchResult && (
        <div className="new-route-results">
          {/* 3.1: road names from jproads */}
          {searchResult.roadNames.map((name) => (
            <div key={name}>
              <div
                className={`new-route-result-item${selectedRoadName === name ? ' new-route-result-item--selected' : ''}`}
                onClick={() => handleRoadNameClick(name)}
              >
                {name}
              </div>
              {selectedRoadName === name && (
                <div className="new-route-actions">
                  {isBuildingRoute ? (
                    <span className="new-route-spinner">ルート構築中…</span>
                  ) : previewData ? (
                    previewData.routes.length > 0 ? (
                      <>
                        <button className="new-route-save-btn" onClick={handleSave} disabled={isSaving}>
                          {isSaving ? '保存中…' : 'save'}
                        </button>
                        <button className="new-route-cancel-btn" onClick={handleCancel}>cancel</button>
                      </>
                    ) : (
                      <>
                        <span className="new-route-no-preview">ルートが見つかりませんでした</span>
                        <button className="new-route-cancel-btn" onClick={handleCancel}>戻る</button>
                      </>
                    )
                  ) : null}
                </div>
              )}
            </div>
          ))}

          {/* Separator between 3.1 and 3.2 */}
          {searchResult.roadNames.length > 0 && searchResult.existingRoutes.length > 0 && (
            <hr className="new-route-divider" />
          )}

          {/* 3.2: existing routes from jproad_routes */}
          {searchResult.existingRoutes.length > 0 && (
            <>
              <div className="new-route-section-label">登録済みルート</div>
              {searchResult.existingRoutes.map((r) => (
                <div
                  key={r.relation_id}
                  className="new-route-result-item new-route-result-item--existing"
                  onClick={() => handleExistingRouteClick(r)}
                >
                  {r.name || '(名称なし)'}
                </div>
              ))}
            </>
          )}

          {searchResult.roadNames.length === 0 && searchResult.existingRoutes.length === 0 && (
            <div className="new-route-no-results">結果なし</div>
          )}
        </div>
      )}
    </div>
  );
};

export default NewRoutePanel;
