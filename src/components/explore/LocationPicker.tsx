"use client";

import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { MapPinIcon } from "@/components/navigation/icons";
import { type Location, getLocation, getLocationContext, searchLocations } from "@/lib/locations";

/**
 * Explore's "Where?" field: a small combobox over Felyn's canonical
 * locations (public.locations, passed in). Typing only narrows the suggestions;
 * the filter changes only when a suggestion is chosen, so results never
 * depend on arbitrary free text. Arrow keys move, Enter selects, Escape
 * closes; clicking outside closes.
 */
export function LocationPicker({
  locations,
  selectedId,
  onSelect,
  inputClassName,
}: {
  /** Felyn's canonical locations (public.locations), loaded server-side by the Explore page. */
  locations: Location[];
  selectedId: string | null;
  onSelect: (locationId: string | null) => void;
  inputClassName: string;
}) {
  const listId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const selected = selectedId ? getLocation(locations, selectedId) : undefined;

  const [text, setText] = useState(selected?.name ?? "");
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);

  const suggestions = searchLocations(locations, selected && text === selected.name ? "" : text);

  useEffect(() => {
    if (!open) return;
    function handlePointerDown(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) close();
    }
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  });

  /** Closing without choosing puts the field back to the current selection (or empty). */
  function close() {
    setOpen(false);
    setText(selected?.name ?? "");
  }

  function choose(id: string) {
    const location = getLocation(locations, id);
    onSelect(id);
    setText(location?.name ?? "");
    setOpen(false);
  }

  function clear() {
    onSelect(null);
    setText("");
    setOpen(false);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        setActiveIndex(0);
        return;
      }
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActiveIndex((index) => (index + step + suggestions.length) % Math.max(suggestions.length, 1));
    } else if (event.key === "Enter") {
      if (open && suggestions[activeIndex]) {
        event.preventDefault();
        choose(suggestions[activeIndex].id);
      }
    } else if (event.key === "Escape") {
      if (open) {
        event.preventDefault();
        close();
      }
    }
  }

  const activeOptionId = open && suggestions[activeIndex] ? `${listId}-${suggestions[activeIndex].id}` : undefined;

  return (
    <div ref={rootRef} className="relative">
      <label className="relative block">
        <span className="sr-only">Location</span>
        <MapPinIcon className="pointer-events-none absolute top-1/2 left-4 h-5 w-5 -translate-y-1/2 text-navy-300" />
        <input
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={activeOptionId}
          autoComplete="off"
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            setOpen(true);
            setActiveIndex(0);
          }}
          onFocus={() => {
            setOpen(true);
            setActiveIndex(0);
          }}
          onKeyDown={handleKeyDown}
          placeholder="Where?"
          className={`${inputClassName} ${selected ? "pr-11 font-medium" : ""}`}
        />
      </label>
      {selected ? (
        <button
          type="button"
          onClick={clear}
          aria-label={`Clear location ${selected.name}`}
          className="absolute top-1/2 right-3 inline-flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full text-navy-500 hover:bg-ivory-200 hover:text-navy-900"
        >
          <span aria-hidden="true" className="text-lg leading-none">
            ×
          </span>
        </button>
      ) : null}

      {open ? (
        <ul
          id={listId}
          role="listbox"
          aria-label="Locations"
          className="absolute top-full right-0 left-0 z-20 mt-2 max-h-80 overflow-y-auto rounded-2xl border border-ivory-300 bg-ivory-50 p-1.5 shadow-lg sm:left-auto sm:w-[22rem]"
        >
          {suggestions.length === 0 ? (
            <li className="px-3 py-3 text-sm text-navy-500">No Felyn locations match “{text.trim()}”.</li>
          ) : (
            suggestions.map((location, index) => (
              <li
                key={location.id}
                id={`${listId}-${location.id}`}
                role="option"
                aria-selected={location.id === selectedId}
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => choose(location.id)}
                onPointerEnter={() => setActiveIndex(index)}
                className={`flex cursor-pointer items-start gap-3 rounded-xl px-3 py-2.5 ${
                  index === activeIndex ? "bg-sky-50" : ""
                }`}
              >
                <span className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-ivory-200 text-navy-500">
                  <MapPinIcon className="h-4 w-4" />
                </span>
                <span className="flex min-w-0 flex-col">
                  <span className="text-sm font-medium text-navy-950">{location.name}</span>
                  <span className="text-xs text-navy-500">{getLocationContext(locations, location)}</span>
                </span>
              </li>
            ))
          )}
        </ul>
      ) : null}
    </div>
  );
}
