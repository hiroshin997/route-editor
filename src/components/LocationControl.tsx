import React from 'react';

interface LocationControlProps {
  /** Selected name at each level, index 0 = level 1 */
  selections: string[];
  /** Options available for each visible level, key is 1-based level number */
  optionsByLevel: { [level: number]: string[] };
  /** Total number of dropdowns to render */
  numDropdowns: number;
  /** Called when the user picks a value. level is 1-based. */
  onSelect: (level: number, name: string) => void;
}

const LocationControl: React.FC<LocationControlProps> = ({
  selections,
  optionsByLevel,
  numDropdowns,
  onSelect,
}) => {
  return (
    <div className="location-control">
      {Array.from({ length: numDropdowns }, (_, i) => {
        const level = i + 1;
        const options = optionsByLevel[level] ?? [];
        const selectedValue = selections[i] ?? '';

        return (
          <React.Fragment key={level}>
            {level > 1 && <span className="location-separator">{'>'}</span>}
            <select
              className="location-select"
              value={selectedValue}
              onChange={(e) => {
                onSelect(level, e.target.value);
              }}
            >
              <option value="">未選択</option>
              {options.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </React.Fragment>
        );
      })}
    </div>
  );
};

export default LocationControl;
