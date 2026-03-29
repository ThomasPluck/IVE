import { useState, useEffect, useRef, useCallback } from 'react';

interface Props {
  onSearch: (query: string) => void;
}

export function SearchBar({ onSearch }: Props) {
  const [value, setValue] = useState('');
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fire = useCallback((q: string) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => onSearch(q), 300);
  }, [onSearch]);

  useEffect(() => () => { if (debounceRef.current) clearTimeout(debounceRef.current); }, []);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setValue(e.target.value);
    fire(e.target.value);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      setValue('');
      if (debounceRef.current) clearTimeout(debounceRef.current);
      onSearch('');
    } else if (e.key === 'Enter') {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      onSearch(value);
    }
  };

  return (
    <div className="ive-search-bar">
      <span className="ive-search-icon">⌕</span>
      <input
        className="ive-search-input"
        type="text"
        placeholder="Search functions…"
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        spellCheck={false}
      />
      {value && (
        <button
          className="ive-search-clear"
          onClick={() => { setValue(''); onSearch(''); }}
          title="Clear"
        >
          ✕
        </button>
      )}
    </div>
  );
}
