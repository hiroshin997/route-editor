import React from 'react';
import Select, { SingleValue, StylesConfig } from 'react-select';

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

interface OptionType {
  value: string;
  label: string;
}

const selectStyles: StylesConfig<OptionType, false> = {
  menuPortal: (base) => ({ ...base, zIndex: 9999 }),
  menuList: (base) => ({ ...base, maxHeight: '85vh' }),
};

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
        const selectOptions: OptionType[] = options.map((name) => ({ value: name, label: name }));
        const selectedOption = selectOptions.find((opt) => opt.value === selectedValue) ?? null;

        return (
          <React.Fragment key={level}>
            {level > 1 && <span className="location-separator">{'>'}</span>}
            <Select<OptionType>
              className="location-select"
              classNamePrefix="location-select"
              options={selectOptions}
              value={selectedOption}
              placeholder="未選択"
              isClearable
              isSearchable
              menuPlacement="auto"
              maxMenuHeight={window.innerHeight * 0.85}
              menuPortalTarget={document.body}
              styles={selectStyles}
              onChange={(option: SingleValue<OptionType>) => {
                onSelect(level, option?.value ?? '');
              }}
            />
          </React.Fragment>
        );
      })}
    </div>
  );
};

export default LocationControl;
